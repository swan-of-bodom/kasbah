import type { RpcStats } from "./rpc/client.ts";

export type Phase = "starting" | "factories" | "backfill" | "keys" | "live" | "done";

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
  readonly #samples: { t: number; through: number; handled: number }[] = [];

  enter(phase: Phase) {
    this.phase = phase;
    this.phaseStarted = performance.now();
    this.#samples.length = 0;
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
   * Blocks and events per second over the last 30 s, and the seconds left at that pace. Recent speed, not the
   * average since the start: event density changes a lot across a chain's history.
   */
  pace(now = performance.now()): { blocks: number; events: number; left: number | undefined } {
    const s = this.#samples;
    if (s.length === 0 || s.at(-1)!.through !== this.range.through || now - s.at(-1)!.t > 1000) s.push({ t: now, through: this.range.through, handled: this.handled });
    while (s.length > 2 && now - s[0]!.t > 30_000) s.shift();
    const a = s[0]!;
    const seconds = (now - a.t) / 1000;
    if (seconds < 2) return { blocks: 0, events: 0, left: undefined };
    const blocks = (this.range.through - a.through) / seconds;
    const events = (this.handled - a.handled) / seconds;
    return { blocks, events, left: blocks > 0 ? (this.range.to - this.range.through) / blocks : undefined };
  }
}
