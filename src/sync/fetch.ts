import type { RpcClient } from "../rpc/client.ts";
import { type EmittedEvent, getEvents } from "../rpc/methods.ts";
import { approxBytes, heapLimit } from "../utils/memory.ts";

export type EventStreamOptions = {
  rpc: RpcClient;
  address: string | string[];
  keys?: string[][];
  /** Inclusive block range. */
  from: number;
  to: number;
  chunkSize: number;
  /** Windows paginating at once. */
  concurrency: number;
  /** Events a window split off for an idle worker should hold, from the density seen so far. Default: two pages. */
  windowEvents?: number;
  /** Smallest range worth splitting off. */
  minSplit?: number;
  maxBufferedBytes?: number;
  budgetShare?: number;
  /** Receives a reader of the stream's state, for `--debug`. */
  gauges?: (read: () => FetchGauges) => void;
};

/** Smallest range, in blocks, worth splitting off a window for an idle worker. */
const MIN_SPLIT = 64;
const MIN_BUFFERED_BYTES = 8 * 2 ** 20;
/** Weight the density seen so far keeps at each page, so cuts follow where events are now. */
const DENSITY_DECAY = 0.9;
/** Past this many times `maxBuffered` held, only the front fetches, so memory stays under 3× (DESIGN.md §3). */
const FRONT_ONLY_PAST = 2;
const BUFFER_SHARE = 1 / 5 / (FRONT_ONLY_PAST + 1);

/** Windows: running (a page in flight), paused (idle, held back by the memory budget), done but not yet read. */
export type FetchGauges = {
  bufferedBytes: number;
  maxBufferedBytes: number;
  bufferedEvents: number;
  windows: number;
  running: number;
  paused: number;
  done: number;
  workers: number;
  idleWorkers: number;
};

/** Events in chain order. Every block up to `through` is complete. */
export type Batch = { events: EmittedEvent[]; through: number };

export type FetchStats = {
  events: number;
  pages: number;
  windows: number;
  splits: number;
  peakBufferedBytes: number;
};

type Window = {
  from: number;
  /** `to_block` of the filter, fixed for the window's lifetime so its continuation token stays valid. */
  to: number;
  until: number;
  fetchedUntil: number;
  token: string | undefined;
  events: EmittedEvent[];
  bytes: number;
  state: "idle" | "running" | "done";
};

const tokenBlock = (token: string): number | undefined => {
  const n = Number(token.slice(0, token.indexOf("-")));
  return Number.isSafeInteger(n) ? n : undefined;
};

/**
 * Every matching event in a block range, in order, with bounded memory. One window starts on the whole range and
 * paginates with its token. When a worker is idle, a window cuts its range just ahead of where it is, about
 * `windowEvents` in, keeps the front part and its token, and hands the rest to a new window. Work stays near the
 * front, so the consumer, reading the lowest window as its pages arrive, rarely waits.
 */
export function eventStream(
  o: EventStreamOptions,
  stats: FetchStats = { events: 0, pages: 0, windows: 0, splits: 0, peakBufferedBytes: 0 },
): AsyncGenerator<Batch> {
  return new EventFetcher(o, stats).stream();
}

class EventFetcher {
  readonly #o: EventStreamOptions;
  readonly #stats: FetchStats;
  readonly #minSplit: number;
  readonly #windowEvents: number;
  readonly #maxBuffered: number;
  readonly #perWindow: number;
  readonly #windows: Window[];
  readonly #workers: Promise<void>[];
  #buffered = 0;
  #waiting = 0;
  #recentEvents = 0;
  #recentBlocks = 0;
  #failure: { error: unknown } | undefined;
  #stopped = false;
  #wakers: (() => void)[] = [];

  constructor(o: EventStreamOptions, stats: FetchStats) {
    this.#o = o;
    this.#stats = stats;
    this.#minSplit = o.minSplit ?? MIN_SPLIT;
    this.#windowEvents = o.windowEvents ?? 2 * o.chunkSize;
    this.#maxBuffered =
      o.maxBufferedBytes ??
      Math.max(MIN_BUFFERED_BYTES, Math.floor(heapLimit() * BUFFER_SHARE * (o.budgetShare ?? 1)));
    this.#perWindow = Math.floor(this.#maxBuffered / o.concurrency);
    this.#windows = [
      {
        from: o.from,
        to: o.to,
        until: o.to + 1,
        fetchedUntil: o.from,
        token: undefined,
        events: [],
        bytes: 0,
        state: "idle",
      },
    ];
    stats.windows = 1;
    this.#workers = Array.from({ length: o.concurrency }, () => this.#worker());
    o.gauges?.(() => this.#gauges());
  }

  async *stream(): AsyncGenerator<Batch> {
    const windows = this.#windows;
    try {
      while (windows.length > 0) {
        if (this.#failure !== undefined) throw this.#failure.error;
        const w = windows[0]!;
        let events: EmittedEvent[];
        let through: number;
        let bytes: number;
        if (w.state === "done") {
          events = w.events;
          bytes = w.bytes;
          windows.shift();
          through = w.until - 1;
        } else {
          // The last fetched block of a running window may be partial: hold its events back.
          let n = w.events.length;
          while (n > 0 && w.events[n - 1]!.block_number! >= w.fetchedUntil) n--;
          if (n === 0) {
            await this.#wait();
            continue;
          }
          events = w.events.splice(0, n);
          bytes = 0;
          for (const e of events) bytes += approxBytes(e);
          w.bytes -= bytes;
          through = w.fetchedUntil - 1;
        }
        this.#buffered -= bytes;
        this.#notify();
        yield { events, through };
      }
      await Promise.all(this.#workers);
    } finally {
      this.#stopped = true;
      this.#notify();
    }
  }

  #notify() {
    const w = this.#wakers;
    this.#wakers = [];
    for (const r of w) r();
  }

  #wait() {
    return new Promise<void>((r) => this.#wakers.push(r));
  }

  #mayFetch(w: Window): boolean {
    const front = w === this.#windows[0];
    if (!front && w.bytes >= this.#perWindow) return false;
    if (this.#buffered < this.#maxBuffered) return true;
    if (!front && this.#buffered >= FRONT_ONLY_PAST * this.#maxBuffered) return false;
    return this.#heldThrough(w) < this.#maxBuffered;
  }

  #heldThrough(w: Window): number {
    let n = 0;
    for (const x of this.#windows) {
      n += x.bytes;
      if (x === w) return n;
    }
    return Number.POSITIVE_INFINITY;
  }

  #pick(): Window | undefined {
    for (const w of this.#windows) {
      if (w.state === "idle" && this.#mayFetch(w)) {
        w.state = "running";
        return w;
      }
    }
    return undefined;
  }

  #span(): number {
    return this.#recentBlocks === 0
      ? Number.POSITIVE_INFINITY
      : this.#windowEvents / (Math.max(this.#recentEvents, 0.5) / this.#recentBlocks);
  }

  #split(w: Window): Window | undefined {
    const left = w.until - w.fetchedUntil;
    if (left < 2 * this.#minSplit) return undefined;
    const cut =
      w.fetchedUntil + Math.round(Math.max(this.#minSplit, Math.min(left / 2, this.#span())));
    const rest: Window = {
      from: cut,
      to: w.until - 1,
      until: w.until,
      fetchedUntil: cut,
      token: undefined,
      events: [],
      bytes: 0,
      state: "idle",
    };
    this.#windows.splice(this.#windows.indexOf(w) + 1, 0, rest);
    w.until = cut;
    this.#stats.windows++;
    this.#stats.splits++;
    return rest;
  }

  #feed() {
    const windows = this.#windows;
    let idle = windows.filter((x) => x.state === "idle").length;
    for (let i = 0; i < windows.length && idle < this.#waiting; i++) {
      const w = windows[i]!;
      if (
        w.state !== "done" &&
        w.until - w.fetchedUntil > 2 * this.#span() &&
        this.#split(w) !== undefined
      )
        idle++;
    }
  }

  async #paginate(w: Window) {
    const o = this.#o;
    const stats = this.#stats;
    const filter = {
      from_block: { block_number: w.from },
      to_block: { block_number: w.to },
      address: o.address,
      keys: o.keys,
    };
    for (;;) {
      if (this.#stopped) return;
      if (!this.#mayFetch(w)) {
        w.state = "idle";
        return;
      }
      const page = await getEvents(o.rpc, filter, o.chunkSize, w.token);
      stats.pages++;
      let kept = 0;
      let bytes = 0;
      for (const e of page.events) {
        if (e.block_number! >= w.until) break;
        w.events.push(e);
        bytes += approxBytes(e);
        kept++;
      }
      w.bytes += bytes;
      this.#buffered += bytes;
      stats.events += kept;
      if (this.#buffered > stats.peakBufferedBytes) stats.peakBufferedBytes = this.#buffered;
      const token = page.continuation_token;
      const at =
        token === undefined
          ? w.until
          : Math.min(w.until, tokenBlock(token) ?? w.events.at(-1)?.block_number ?? w.fetchedUntil);
      this.#recentEvents = this.#recentEvents * DENSITY_DECAY + kept;
      this.#recentBlocks = this.#recentBlocks * DENSITY_DECAY + Math.max(0, at - w.fetchedUntil);
      if (at >= w.until) {
        w.fetchedUntil = w.until;
        w.state = "done";
        this.#notify();
        return;
      }
      w.fetchedUntil = Math.max(w.fetchedUntil, at);
      w.token = token;
      if (this.#waiting > 0) this.#feed();
      this.#notify();
    }
  }

  async #worker() {
    while (
      !this.#stopped &&
      this.#failure === undefined &&
      !this.#windows.every((w) => w.state === "done")
    ) {
      const w = this.#pick();
      if (w === undefined) {
        this.#waiting++;
        await this.#wait();
        this.#waiting--;
        continue;
      }
      try {
        await this.#paginate(w);
      } catch (error) {
        this.#failure = { error };
        this.#notify();
        return;
      }
    }
    this.#notify();
  }

  #gauges(): FetchGauges {
    const count = (state: Window["state"]) => this.#windows.filter((w) => w.state === state).length;
    return {
      bufferedBytes: this.#buffered,
      maxBufferedBytes: this.#maxBuffered,
      bufferedEvents: this.#windows.reduce((n, w) => n + w.events.length, 0),
      windows: this.#windows.length,
      running: count("running"),
      paused: count("idle"),
      done: count("done"),
      workers: this.#workers.length,
      idleWorkers: this.#waiting,
    };
  }
}

/** Fetches a whole range, handing each ordered batch to `onEvents`. */
export async function fetchEvents(
  o: EventStreamOptions & { onEvents: (events: EmittedEvent[], through: number) => void },
): Promise<FetchStats> {
  const stats: FetchStats = { events: 0, pages: 0, windows: 0, splits: 0, peakBufferedBytes: 0 };
  for await (const batch of eventStream(o, stats)) o.onEvents(batch.events, batch.through);
  return stats;
}
