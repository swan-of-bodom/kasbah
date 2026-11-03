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
  /** The parts of the range to fetch, inclusive, in order; the rest is in `store` already. Default: all of it. */
  ranges?: [number, number][];
  /** Writes pages here instead of holding them: the stream then yields how far `store` has every block, no events. */
  store?: PageStore;
  chunkSize: number;
  /** Windows paginating at once. */
  concurrency: number;
  /** Events a window split off for an idle worker should hold, from the density seen so far. Default: two pages. */
  windowEvents?: number;
  /** Smallest range worth splitting off. */
  minSplit?: number;
  /** Most windows at once. Default: `MAX_WINDOWS_PER_WORKER` per worker. */
  maxWindows?: number;
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
/** Windows with this share of the budget held before them fetch only while the buffer is under it: the rest stays for the front. */
const FRONT_RESERVE = 0.5;
/** Most windows per worker: Ekubo's history peaks near 4, so this only stops a runaway, whatever cuts windows. */
const MAX_WINDOWS_PER_WORKER = 8;
/**
 * With a store, pages per worker fetched past the front window before the windows further on pause: the handlers
 * read only up to the front, so idle workers then split it instead. On disk, not in memory. Without it, every worker
 * stayed far ahead and the front advanced one page at a time (Ekubo, 2026-11-03: 13.8M fetched, 2.1M handled).
 */
const AHEAD_PAGES_PER_WORKER = 8;

/** Span of `workerTime`: a few seconds, so it follows the stretch being fetched without flickering. */
const TIME_SHARE_MS = 5_000;

/**
 * Where a fetch writes its pages (the event cache). Pages of different windows arrive out of order, a window's own in
 * order, and writes settle in the order they were given.
 */
export type PageStore = {
  /** Writes `events`, every event of blocks `[from, to]`; settles once they are written. */
  write(events: EmittedEvent[], from: number, to: number): Promise<void>;
  /** Settles when the store takes another page: a slow store slows fetching, and memory stays bounded. */
  room(): Promise<void>;
  /** Fetched events waiting to be written, and the most bytes it holds. */
  held(): { bytes: number; events: number; max: number };
};

/**
 * Windows: running (a page in flight), paused (idle, held back by the memory budget), done but not yet read.
 * With a store, buffered means fetched and not yet written, and `written` is the block it has everything through.
 */
export type FetchGauges = {
  bufferedBytes: number;
  maxBufferedBytes: number;
  bufferedEvents: number;
  written?: number;
  windows: number;
  running: number;
  paused: number;
  done: number;
  workers: number;
  idleWorkers: number;
  /** Shares of the workers' time over the last few seconds: in `getEvents` (pacing included), waiting for the store's room, idle. */
  workerTime: { calls: number; room: number; idle: number };
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
  /** With a store: every block before this one is written. */
  written: number;
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
  readonly #maxWindows: number;
  readonly #windowEvents: number;
  readonly #maxBuffered: number;
  readonly #perWindow: number;
  readonly #maxAhead: number;
  readonly #windows: Window[];
  readonly #workers: Promise<void>[];
  #buffered = 0;
  /** Bytes reserved for pages being downloaded, at the recent page size: the ceiling counts them too. */
  #inFlight = 0;
  #pageBytes = 0;
  #waiting = 0;
  /** Worker milliseconds so far: in `getEvents`, waiting for the store's room, idle. */
  #spent = { calls: 0, room: 0, idle: 0 };
  #spentMark = { at: performance.now(), calls: 0, room: 0, idle: 0 };
  #workerTime = { calls: 0, room: 0, idle: 0 };
  #recentEvents = 0;
  #recentBlocks = 0;
  #failure: { error: unknown } | undefined;
  #stopped = false;
  #wakers: (() => void)[] = [];

  constructor(o: EventStreamOptions, stats: FetchStats) {
    this.#o = o;
    this.#stats = stats;
    this.#minSplit = o.minSplit ?? MIN_SPLIT;
    this.#maxWindows = o.maxWindows ?? MAX_WINDOWS_PER_WORKER * o.concurrency;
    this.#windowEvents = o.windowEvents ?? 2 * o.chunkSize;
    this.#maxBuffered =
      o.maxBufferedBytes ??
      Math.max(MIN_BUFFERED_BYTES, Math.floor(heapLimit() * BUFFER_SHARE * (o.budgetShare ?? 1)));
    this.#perWindow = Math.floor(this.#maxBuffered / o.concurrency);
    this.#maxAhead = AHEAD_PAGES_PER_WORKER * o.concurrency * o.chunkSize;
    this.#windows = (o.ranges ?? [[o.from, o.to]]).map(([from, to]) => ({
      from,
      to,
      until: to + 1,
      fetchedUntil: from,
      written: from,
      token: undefined,
      events: [],
      bytes: 0,
      state: "idle",
    }));
    stats.windows = this.#windows.length;
    this.#workers = Array.from({ length: o.concurrency }, () => this.#worker());
    o.gauges?.(() => this.#gauges());
  }

  stream(): AsyncGenerator<Batch> {
    return this.#o.store === undefined ? this.#events() : this.#frontier();
  }

  /** How far the store has every block, each time it moves: no events. */
  async *#frontier(): AsyncGenerator<Batch> {
    const windows = this.#windows;
    let yielded = this.#o.from - 1;
    try {
      for (;;) {
        if (this.#failure !== undefined) throw this.#failure.error;
        if (windows[0] !== undefined && windows[0].written === windows[0].until) {
          while (windows[0] !== undefined && windows[0].written === windows[0].until)
            windows.shift();
          // A new front: the windows after it hold less ahead of it.
          this.#notify();
        }
        // Blocks before the first window still being fetched or written are in the store, as are gaps between windows.
        const through = (windows[0]?.written ?? this.#o.to + 1) - 1;
        if (through > yielded) {
          yielded = through;
          yield { events: [], through };
        } else if (windows.length === 0) break;
        else await this.#wait();
      }
      await Promise.all(this.#workers);
    } finally {
      this.#stopped = true;
      this.#notify();
    }
  }

  async *#events(): AsyncGenerator<Batch> {
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

  #mayFetch(w: Window, held = this.#heldThrough(w)): boolean {
    const front = w === this.#windows[0];
    if (this.#o.store !== undefined) return this.#roomAt(held, front);
    if (!front && w.bytes >= this.#perWindow) return false;
    return this.#roomAt(held, front);
  }

  /**
   * Whether the budget lets a window fetch when it and the windows before it hold `held` bytes. With a store,
   * `held` is events fetched past the front window, and only how far ahead a window is counts.
   */
  #roomAt(held: number, front: boolean): boolean {
    if (this.#o.store !== undefined) return front || held < this.#maxAhead;
    const used = this.#buffered + this.#inFlight;
    const reserve = FRONT_RESERVE * this.#maxBuffered;
    if (!front && held >= reserve) return used < reserve;
    if (used < this.#maxBuffered) return true;
    if (!front && used >= FRONT_ONLY_PAST * this.#maxBuffered) return false;
    return held < this.#maxBuffered;
  }

  /** What a window holds toward the budget: with a store, the front's events are the ones being read. */
  #held(w: Window): number {
    return this.#o.store !== undefined && w === this.#windows[0] ? 0 : w.bytes;
  }

  #heldThrough(w: Window): number {
    let n = 0;
    for (const x of this.#windows) {
      n += this.#held(x);
      if (x === w) return n;
    }
    return Number.POSITIVE_INFINITY;
  }

  #pick(): Window | undefined {
    let held = 0;
    for (const w of this.#windows) {
      held += this.#held(w);
      if (w.state === "idle" && this.#mayFetch(w, held)) {
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
    if (left < 2 * this.#minSplit || this.#windows.length >= this.#maxWindows) return undefined;
    const cut =
      w.fetchedUntil + Math.round(Math.max(this.#minSplit, Math.min(left / 2, this.#span())));
    const rest: Window = {
      from: cut,
      to: w.until - 1,
      until: w.until,
      fetchedUntil: cut,
      written: cut,
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
    let held = 0;
    let idle = 0;
    for (const w of windows) {
      held += this.#held(w);
      if (w.state === "idle" && this.#mayFetch(w, held)) idle++;
    }
    held = 0;
    for (let i = 0; i < windows.length && idle < this.#waiting; i++) {
      const w = windows[i]!;
      held += this.#held(w);
      if (!this.#roomAt(held, false)) return;
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
      if (o.store !== undefined) {
        const t = performance.now();
        await o.store.room();
        this.#spent.room += performance.now() - t;
      }
      if (this.#stopped) return;
      if (!this.#mayFetch(w)) {
        w.state = "idle";
        return;
      }
      const reserved = this.#pageBytes;
      this.#inFlight += reserved;
      let page: Awaited<ReturnType<typeof getEvents>>;
      const t = performance.now();
      try {
        page = await getEvents(o.rpc, filter, o.chunkSize, w.token);
      } finally {
        this.#inFlight -= reserved;
        this.#spent.calls += performance.now() - t;
      }
      stats.pages++;
      let kept = 0;
      let bytes = 0;
      for (const e of page.events) {
        if (e.block_number! >= w.until) break;
        w.events.push(e);
        if (o.store === undefined) bytes += approxBytes(e);
        kept++;
      }
      // With a store, a window holds events counted, not bytes: they're written, not kept.
      w.bytes += o.store === undefined ? bytes : kept;
      this.#buffered += bytes;
      this.#pageBytes =
        stats.pages === 1 ? bytes : this.#pageBytes * DENSITY_DECAY + bytes * (1 - DENSITY_DECAY);
      stats.events += kept;
      if (this.#buffered > stats.peakBufferedBytes) stats.peakBufferedBytes = this.#buffered;
      const token = page.continuation_token;
      const at =
        token === undefined
          ? w.until
          : Math.min(w.until, tokenBlock(token) ?? w.events.at(-1)?.block_number ?? w.fetchedUntil);
      this.#recentEvents = this.#recentEvents * DENSITY_DECAY + kept;
      this.#recentBlocks = this.#recentBlocks * DENSITY_DECAY + Math.max(0, at - w.fetchedUntil);
      if (o.store !== undefined) this.#write(o.store, w, Math.min(at, w.until));
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

  /** Writes the window's blocks before `end`, complete now; the events of a block still being fetched stay. */
  #write(store: PageStore, w: Window, end: number) {
    if (end <= w.fetchedUntil) return;
    let n = w.events.length;
    while (n > 0 && w.events[n - 1]!.block_number! >= end) n--;
    store.write(w.events.splice(0, n), w.fetchedUntil, end - 1).then(
      () => {
        w.written = end;
        this.#notify();
      },
      (error: unknown) => {
        this.#failure ??= { error };
        this.#notify();
      },
    );
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
        const t = performance.now();
        await this.#wait();
        this.#spent.idle += performance.now() - t;
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
    const held = this.#o.store?.held();
    return {
      bufferedBytes: held?.bytes ?? this.#buffered,
      maxBufferedBytes: held?.max ?? this.#maxBuffered,
      bufferedEvents: held?.events ?? this.#windows.reduce((n, w) => n + w.events.length, 0),
      ...(held && { written: (this.#windows[0]?.written ?? this.#o.to + 1) - 1 }),
      windows: this.#windows.length,
      running: count("running"),
      paused: count("idle"),
      done: count("done"),
      workers: this.#workers.length,
      idleWorkers: this.#waiting,
      workerTime: this.#timeShares(),
    };
  }

  /** `workerTime`, from what the workers spent since a mark at least `TIME_SHARE_MS` old. */
  #timeShares() {
    const now = performance.now();
    const m = this.#spentMark;
    if (now - m.at < TIME_SHARE_MS) return this.#workerTime;
    const total = Math.max(1, (now - m.at) * this.#workers.length);
    this.#workerTime = {
      calls: (this.#spent.calls - m.calls) / total,
      room: (this.#spent.room - m.room) / total,
      idle: (this.#spent.idle - m.idle) / total,
    };
    this.#spentMark = { at: now, ...this.#spent };
    return this.#workerTime;
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
