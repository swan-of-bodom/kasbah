import type { RpcStats } from "./rpc/client.ts";

export type Phase = "starting" | "factories" | "backfill" | "keys" | "live" | "done";

/** Seconds per point of the events/s history, and points kept (2 minutes). */
const BUCKET_MS = 2000;
const BUCKETS = 60;

export type Pace = {
  blocks: number;
  events: number;
  /** Seconds left at the recent pace. */
  left: number | undefined;
  /** Seconds left at the recent pace and at the phase's average, low first: far apart, the estimate is rough. */
  range: [number, number] | undefined;
};

/** What a run is doing, updated in place by `run` and read by the dev screen. */
export class Status {
  phase: Phase = "starting";
  readonly started = performance.now();
  phaseStarted = performance.now();
  schema = "";
  endpoint = "";
  tip = 0;
  contracts = 0;
  factories = 0;
  children = 0;
  /** Blocks of the current phase (factories or backfill): `first..to`, done through `through`. */
  range = { first: 0, to: 0, through: 0 };
  /** Events and block handlers handled. */
  handled = 0;
  readonly handlers = new Map<string, { count: number; ms: number }>();
  /** Milliseconds spent waiting for events, in handlers and committing (backfill and live). */
  readonly time = { fetch: 0, handlers: 0, commit: 0 };
  lastCommit = { ms: 0, tables: 0, cache: 0 };
  keys = { tables: 0, indexes: 0 };
  live = { block: 0, timestamp: 0, events: 0, at: 0, reorgs: 0 };
  api = "";
  rpc?: RpcStats;
  concurrency = () => 0;
  cache?: { cachedEvents: number; fetchedEvents: number };
  calls?: { calls: number; cached: number };
  /** Events handled per second, one point per 2 s, oldest first. */
  readonly history: number[] = [];
  readonly #samples: { t: number; through: number; handled: number }[] = [];
  #bucket = { t: performance.now(), handled: 0 };
  #phaseStart = { through: 0 };

  enter(phase: Phase) {
    this.phase = phase;
    this.phaseStarted = performance.now();
    this.#samples.length = 0;
  }

  /** Sets the phase's block range (its progress starts at `through`). */
  setRange(first: number, to: number, through: number) {
    this.range = { first, to, through };
    this.#phaseStart = { through };
  }

  record(name: string, ms: number) {
    let h = this.handlers.get(name);
    if (h === undefined) this.handlers.set(name, (h = { count: 0, ms: 0 }));
    h.count++;
    h.ms += ms;
    this.time.handlers += ms;
    this.handled++;
  }

  /**
   * Blocks and events per second over the last 30 s, and the time left at that pace. Recent speed rather than the
   * average since the start: event density changes a lot along a chain, so both are given as a range.
   */
  pace(now = performance.now()): Pace {
    while (now - this.#bucket.t >= BUCKET_MS) {
      this.history.push(((this.handled - this.#bucket.handled) / (now - this.#bucket.t)) * 1000);
      if (this.history.length > BUCKETS) this.history.shift();
      this.#bucket = { t: now, handled: this.handled };
    }
    const s = this.#samples;
    if (s.length === 0 || s.at(-1)!.through !== this.range.through || now - s.at(-1)!.t > 1000) s.push({ t: now, through: this.range.through, handled: this.handled });
    while (s.length > 2 && now - s[0]!.t > 30_000) s.shift();
    const a = s[0]!;
    const seconds = (now - a.t) / 1000;
    if (seconds < 2) return { blocks: 0, events: 0, left: undefined, range: undefined };
    const blocks = (this.range.through - a.through) / seconds;
    const events = (this.handled - a.handled) / seconds;
    const remaining = this.range.to - this.range.through;
    const left = blocks > 0 ? remaining / blocks : undefined;
    const average = (this.range.through - this.#phaseStart.through) / ((now - this.phaseStarted) / 1000);
    const overall = average > 0 ? remaining / average : undefined;
    const range = left === undefined || overall === undefined ? undefined : ([Math.min(left, overall), Math.max(left, overall)] as [number, number]);
    return { blocks, events, left, range };
  }
}
