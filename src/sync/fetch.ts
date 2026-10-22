import type { RpcClient } from "../rpc/client.ts";
import { type EmittedEvent, getEvents } from "../rpc/methods.ts";

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
  /** Events in memory before windows pause (see `mayFetch`). Default: enough for four windows per worker. */
  maxBuffered?: number;
  /** Receives a reader of the stream's state, for `--debug`. */
  gauges?: (read: () => FetchGauges) => void;
};

/** Smallest range, in blocks, worth splitting off a window for an idle worker. */
const MIN_SPLIT = 64;
/** The memory budget's floor, for small `concurrency` or sparse windows. */
const MIN_BUFFERED = 10_000;

/** Windows: running (a page in flight), paused (idle, held back by the memory budget), done but not yet read. */
export type FetchGauges = {
  buffered: number;
  maxBuffered: number;
  windows: number;
  running: number;
  paused: number;
  done: number;
  idleWorkers: number;
};

/** Events in chain order. Every block up to `through` is complete. */
export type Batch = { events: EmittedEvent[]; through: number };

export type FetchStats = {
  events: number;
  pages: number;
  windows: number;
  splits: number;
  peakBuffered: number;
};

type Window = {
  from: number;
  /** `to_block` of the filter, fixed for the window's lifetime so its continuation token stays valid. */
  to: number;
  /** Exclusive end; lowered when the window hands the rest of its range to a new window. */
  stop: number;
  /** Blocks before `at` are fully fetched. */
  at: number;
  token: string | undefined;
  events: EmittedEvent[];
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
  stats: FetchStats = { events: 0, pages: 0, windows: 0, splits: 0, peakBuffered: 0 },
): AsyncGenerator<Batch> {
  return new EventFetcher(o, stats).stream();
}

/** One `eventStream`: its windows, the workers paginating them, and the memory they hold. Workers start at once. */
class EventFetcher {
  readonly #o: EventStreamOptions;
  readonly #stats: FetchStats;
  readonly #minSplit: number;
  readonly #windowEvents: number;
  readonly #maxBuffered: number;
  /** What a window other than the front may hold before it pauses, so one dense window can't take the budget. */
  readonly #perWindow: number;
  readonly #windows: Window[];
  readonly #workers: Promise<void>[];
  #buffered = 0;
  #waiting = 0;
  // Recent events and blocks fetched, decayed per page: the density that places cuts.
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
      o.maxBuffered ?? Math.max(MIN_BUFFERED, 4 * o.concurrency * this.#windowEvents);
    this.#perWindow = Math.max(
      4 * this.#windowEvents,
      Math.floor(this.#maxBuffered / o.concurrency),
    );
    this.#windows = [
      {
        from: o.from,
        to: o.to,
        stop: o.to + 1,
        at: o.from,
        token: undefined,
        events: [],
        state: "idle",
      },
    ];
    stats.windows = 1;
    this.#workers = Array.from({ length: o.concurrency }, () => this.#worker());
    o.gauges?.(() => this.#gauges());
  }

  /** The batches, front window first. Ending it early (`return`, a throw) stops the workers. */
  async *stream(): AsyncGenerator<Batch> {
    const windows = this.#windows;
    try {
      while (windows.length > 0) {
        if (this.#failure !== undefined) throw this.#failure.error;
        const w = windows[0]!;
        let events: EmittedEvent[];
        let through: number;
        if (w.state === "done") {
          events = w.events;
          windows.shift();
          through = w.stop - 1;
        } else {
          // The last fetched block of a running window may be partial: hold its events back.
          let n = w.events.length;
          while (n > 0 && w.events[n - 1]!.block_number! >= w.at) n--;
          if (n === 0) {
            await this.#wait();
            continue;
          }
          events = w.events.splice(0, n);
          through = w.at - 1;
        }
        this.#buffered -= events.length;
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

  /**
   * A window other than the front pauses at `perWindow` events. Under `maxBuffered` events held, any window may
   * fetch; under twice that, only windows that hold fewer together with the windows before them, so the front never
   * waits for the back. Past that, only the front, which the consumer drains. Memory stays under three times the
   * budget.
   */
  #mayFetch(w: Window): boolean {
    const front = this.#windows[0];
    if (w !== front && w.events.length >= this.#perWindow) return false;
    if (this.#buffered < this.#maxBuffered) return true;
    if (this.#buffered >= 2 * this.#maxBuffered && w !== front) return false;
    let n = 0;
    for (const x of this.#windows) {
      n += x.events.length;
      if (x === w) return n < this.#maxBuffered;
    }
    return false;
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

  /** Blocks that hold about `windowEvents` at the density seen lately. */
  #span(): number {
    return this.#recentBlocks === 0
      ? Number.POSITIVE_INFINITY
      : this.#windowEvents / (Math.max(this.#recentEvents, 0.5) / this.#recentBlocks);
  }

  /** Cuts `w` about `windowEvents` past where it is, and hands the rest of its range to a new idle window. */
  #split(w: Window): Window | undefined {
    const left = w.stop - w.at;
    if (left < 2 * this.#minSplit) return undefined;
    const cut = w.at + Math.round(Math.max(this.#minSplit, Math.min(left / 2, this.#span())));
    const rest: Window = {
      from: cut,
      to: w.stop - 1,
      stop: w.stop,
      at: cut,
      token: undefined,
      events: [],
      state: "idle",
    };
    this.#windows.splice(this.#windows.indexOf(w) + 1, 0, rest);
    w.stop = cut;
    this.#stats.windows++;
    this.#stats.splits++;
    return rest;
  }

  /** For waiting workers: walks from the front, cutting every window much longer than `span()` into one that size. */
  #feed() {
    const windows = this.#windows;
    let idle = windows.filter((x) => x.state === "idle").length;
    for (let i = 0; i < windows.length && idle < this.#waiting; i++) {
      const w = windows[i]!;
      if (w.state !== "done" && w.stop - w.at > 2 * this.#span() && this.#split(w) !== undefined)
        idle++;
    }
  }

  /** Paginates `w` until it's done, the stream stops, or the memory budget pauses it. */
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
      for (const e of page.events) {
        if (e.block_number! >= w.stop) break;
        w.events.push(e);
        kept++;
      }
      this.#buffered += kept;
      stats.events += kept;
      if (this.#buffered > stats.peakBuffered) stats.peakBuffered = this.#buffered;
      const token = page.continuation_token;
      const at =
        token === undefined
          ? w.stop
          : Math.min(w.stop, tokenBlock(token) ?? w.events.at(-1)?.block_number ?? w.at);
      this.#recentEvents = this.#recentEvents * 0.9 + kept;
      this.#recentBlocks = this.#recentBlocks * 0.9 + Math.max(0, at - w.at);
      if (at >= w.stop) {
        w.at = w.stop;
        w.state = "done";
        this.#notify();
        return;
      }
      w.at = Math.max(w.at, at);
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
      buffered: this.#buffered,
      maxBuffered: this.#maxBuffered,
      windows: this.#windows.length,
      running: count("running"),
      paused: count("idle"),
      done: count("done"),
      idleWorkers: this.#waiting,
    };
  }
}

/** Fetches a whole range, handing each ordered batch to `onEvents`. */
export async function fetchEvents(
  o: EventStreamOptions & { onEvents: (events: EmittedEvent[], through: number) => void },
): Promise<FetchStats> {
  const stats: FetchStats = { events: 0, pages: 0, windows: 0, splits: 0, peakBuffered: 0 };
  for await (const batch of eventStream(o, stats)) o.onEvents(batch.events, batch.through);
  return stats;
}
