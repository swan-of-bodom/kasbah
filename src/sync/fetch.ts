import type { RpcClient } from "../rpc/client.ts";
import { type EmittedEvent, getEvents } from "../rpc/methods.ts";

export type EventStreamOptions = {
  rpc: RpcClient;
  address: string | string[];
  keys?: string[][];
  /** Inclusive block range. */
  from: number;
  to: number;
  /** The parts of the range to fetch, inclusive, in order; the rest is in `store` already. Default: all of it. */
  ranges?: [number, number][];
  /** Where pages are written: the stream yields how far it has every block, no events. */
  store: PageStore;
  chunkSize: number;
  /** Windows paginating at once. */
  concurrency: number;
  /** Events a window split off for an idle worker should hold, from the density seen so far. Default: two pages. */
  windowEvents?: number;
  /** Smallest range worth splitting off. */
  minSplit?: number;
  /** Most windows at once. Default: `WINDOWS.maxPerWorker` per worker. */
  maxWindows?: number;
  /** Receives a reader of the stream's state, for `--debug`. */
  gauges?: (read: () => FetchGauges) => void;
};

/** How the block range is cut into windows for the workers. */
const WINDOWS = {
  /** Smallest range, in blocks, worth splitting off a window for an idle worker. */
  minSplit: 64,
  /** Most windows per worker: Ekubo's history peaks near 4, so this only stops a runaway, whatever cuts windows. */
  maxPerWorker: 8,
  /**
   * Pages per worker fetched past the front window before the windows further on pause: the handlers read only up to
   * the front, so idle workers then split it instead. On disk, not in memory. Without it, every worker stayed far
   * ahead and the front advanced one page at a time (Ekubo, 2026-11-03: 13.8M fetched, 2.1M handled).
   */
  aheadPagesPerWorker: 8,
  /** Weight the density seen so far keeps at each page, so cuts follow where events are now. */
  densityDecay: 0.9,
};

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
 * Windows: running (a page in flight), paused (held back by the ahead limit), done but not yet written. Buffered
 * means fetched and not yet written, and `written` is the block the store has everything through.
 */
export type FetchGauges = {
  bufferedBytes: number;
  maxBufferedBytes: number;
  bufferedEvents: number;
  written: number;
  windows: number;
  running: number;
  paused: number;
  done: number;
  workers: number;
  idleWorkers: number;
  /** Shares of the workers' time over the last few seconds: in `getEvents` (pacing included), waiting for the store's room, idle; none before the first few seconds are measured. */
  workerTime: { calls: number; room: number; idle: number } | undefined;
};

/** Events in chain order. Every block up to `through` is complete. */
export type Batch = { events: EmittedEvent[]; through: number };

export type FetchStats = { events: number; pages: number; windows: number; splits: number };

type Window = {
  from: number;
  /** `to_block` of the filter, fixed for the window's lifetime so its continuation token stays valid. */
  to: number;
  until: number;
  fetchedUntil: number;
  /** Every block before this one is written. */
  written: number;
  token: string | undefined;
  /** Fetched events of a block not yet complete, written with the page that completes it. */
  events: EmittedEvent[];
  /** Events fetched in all: how far ahead of the front this window is. */
  fetched: number;
  state: "idle" | "running" | "done";
};

const tokenBlock = (token: string): number | undefined => {
  const n = Number(token.slice(0, token.indexOf("-")));
  return Number.isSafeInteger(n) ? n : undefined;
};

/**
 * Every matching event in a block range, written to `store`, yielding how far it has every block. One window starts
 * on each range and paginates with its token. When a worker is idle, a window cuts its range just ahead of where it
 * is, about `windowEvents` in, keeps the front part and its token, and hands the rest to a new window. Work stays
 * near the front, so the reader, which reads only up to it, rarely waits.
 */
export function eventStream(
  o: EventStreamOptions,
  stats: FetchStats = { events: 0, pages: 0, windows: 0, splits: 0 },
): AsyncGenerator<Batch> {
  return new EventFetcher(o, stats).stream();
}

class EventFetcher {
  readonly #o: EventStreamOptions;
  readonly #stats: FetchStats;
  readonly #minSplit: number;
  readonly #maxWindows: number;
  readonly #windowEvents: number;
  readonly #maxAhead: number;
  readonly #windows: Window[];
  readonly #workers: Promise<void>[];
  #waiting = 0;
  /** Worker milliseconds so far: in `getEvents`, waiting for the store's room, idle. */
  #spent = { calls: 0, room: 0, idle: 0 };
  #spentMark = { at: performance.now(), calls: 0, room: 0, idle: 0 };
  #workerTime: FetchGauges["workerTime"];
  #recentEvents = 0;
  #recentBlocks = 0;
  #failure: { error: unknown } | undefined;
  #stopped = false;
  #wakers: (() => void)[] = [];

  constructor(o: EventStreamOptions, stats: FetchStats) {
    this.#o = o;
    this.#stats = stats;
    this.#minSplit = o.minSplit ?? WINDOWS.minSplit;
    this.#maxWindows = o.maxWindows ?? WINDOWS.maxPerWorker * o.concurrency;
    this.#windowEvents = o.windowEvents ?? 2 * o.chunkSize;
    this.#maxAhead = WINDOWS.aheadPagesPerWorker * o.concurrency * o.chunkSize;
    this.#windows = (o.ranges ?? [[o.from, o.to]]).map(([from, to]) => ({
      from,
      to,
      until: to + 1,
      fetchedUntil: from,
      written: from,
      token: undefined,
      events: [],
      fetched: 0,
      state: "idle",
    }));
    stats.windows = this.#windows.length;
    this.#workers = Array.from({ length: o.concurrency }, () => this.#worker());
    o.gauges?.(() => this.#gauges());
  }

  /** How far the store has every block, each time it moves: no events. */
  async *stream(): AsyncGenerator<Batch> {
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

  #notify() {
    const w = this.#wakers;
    this.#wakers = [];
    for (const r of w) r();
  }

  #wait() {
    return new Promise<void>((r) => this.#wakers.push(r));
  }

  #mayFetch(w: Window, held = this.#heldThrough(w)): boolean {
    return this.#roomAt(held, w === this.#windows[0]);
  }

  /** Whether a window may fetch with `held` events fetched past the front window, up to and including it. */
  #roomAt(held: number, front: boolean): boolean {
    return front || held < this.#maxAhead;
  }

  /** What a window counts toward the ahead limit: the front's events are the ones being read. */
  #held(w: Window): number {
    return w === this.#windows[0] ? 0 : w.fetched;
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
      fetched: 0,
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
      const waited = performance.now();
      await o.store.room();
      this.#spent.room += performance.now() - waited;
      if (this.#stopped) return;
      if (!this.#mayFetch(w)) {
        w.state = "idle";
        return;
      }
      let page: Awaited<ReturnType<typeof getEvents>>;
      const t = performance.now();
      try {
        page = await getEvents(o.rpc, filter, o.chunkSize, w.token);
      } finally {
        this.#spent.calls += performance.now() - t;
      }
      stats.pages++;
      let kept = 0;
      for (const e of page.events) {
        if (e.block_number! >= w.until) break;
        w.events.push(e);
        kept++;
      }
      w.fetched += kept;
      stats.events += kept;
      const token = page.continuation_token;
      const at =
        token === undefined
          ? w.until
          : Math.min(w.until, tokenBlock(token) ?? w.events.at(-1)?.block_number ?? w.fetchedUntil);
      this.#recentEvents = this.#recentEvents * WINDOWS.densityDecay + kept;
      this.#recentBlocks =
        this.#recentBlocks * WINDOWS.densityDecay + Math.max(0, at - w.fetchedUntil);
      this.#write(o.store, w, Math.min(at, w.until));
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
    const held = this.#o.store.held();
    return {
      bufferedBytes: held.bytes,
      maxBufferedBytes: held.max,
      bufferedEvents: held.events,
      written: (this.#windows[0]?.written ?? this.#o.to + 1) - 1,
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
