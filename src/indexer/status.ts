import { monitorEventLoopDelay } from "node:perf_hooks";
import type { EndpointStats, RpcStats } from "../rpc/client.ts";
import type { FetchGauges } from "../sync/fetch.ts";
import { secondsSince } from "../utils/time.ts";

export type Phase = "starting" | "factories" | "backfill" | "keys" | "live" | "done" | "failed";

/** Milliseconds per point of the events/s history, and points kept (2 minutes). */
const BUCKET_MS = 2_000;
const BUCKETS = 60;
/** Event-loop delay sampling; its own interval is subtracted from what it measures. */
const LAG_RESOLUTION_MS = 10;

/** The last minute of RPC and fetcher activity, from one sample per second. */
export type Recent = {
  /** Calls per second over the last 5 s. */
  callsPerSecond: number;
  throttled: number;
  timeouts: number;
  failed: number;
  /** Share of the last 5 s the run spent waiting for events, and for headers and transactions. */
  waitingEvents: number;
  waitingExtras: number;
  /** Event loop delay over the last second, ms (with `debug`). */
  lag?: { max: number; p50: number };
};

type Sample = {
  t: number;
  calls: number;
  throttled: number;
  timeouts: number;
  failed: number;
  events: number;
  extras: number;
};

export type Pace = {
  blocks: number;
  events: number;
  /** Seconds left at the recent pace. */
  left: number | undefined;
  /** Seconds left at the recent pace and at the phase's average, low first: far apart, the estimate is rough. */
  range: [number, number] | undefined;
};

/** Something a run reports once, when it happens. The rest of `Status` is its current state. */
export type Note =
  /** `onBuildChange: "reset"` and the schema held another build. */
  | { kind: "rebuild" }
  | { kind: "api"; url: string }
  /** `to` was inside the reorg window: indexing stops at `through`, the last final block. */
  | { kind: "clamped"; to: number; through: number; tip: number; window: number }
  | {
      kind: "endpoint";
      node: string;
      spec: string;
      tip: number;
      contracts: number;
      factories: number;
      blockSources: number;
    }
  /** Blocks after `ancestor` were replaced (`block`, the newest indexed, among them) and are undone. */
  | {
      kind: "reorg";
      block: number;
      hash: string;
      ancestor: number;
      rows: number;
      children: number;
      stopped: boolean;
    }
  | {
      kind: "class";
      contract: string;
      address: string;
      changes: { block: number; classHash: string }[];
    }
  /** Events of a contract's class that its configured ABI lacks: once per contract and event name. */
  | { kind: "skipped"; contract: string; events: string[]; classHash: string }
  | { kind: "socket"; state: "on" | "refused" | "reconnected" | "closed"; reason?: string }
  | { kind: "factories"; children: number; through: number; seconds: number }
  | {
      kind: "backfill";
      handled: number;
      seconds: number;
      cache?: { cachedEvents: number; fetchedEvents: number };
      reads: number;
      cachedReads: number;
      rpc?: { calls: number; throttled: number; rate: number };
    }
  | { kind: "keys"; keys: number; indexes: number; seconds: number }
  | { kind: "following"; block: number }
  /** Every backfill commit, and every live block with events or new children: what the screen's box shows. */
  | {
      kind: "progress";
      phase: "backfill";
      through: number;
      first: number;
      to: number;
      handled: number;
      seconds: number;
      ms: number;
      tables: number;
      cache?: number;
    }
  | {
      kind: "progress";
      phase: "live";
      block: number;
      events: number;
      children: number;
      behind: number;
    };

/** A note as listeners get it: with its time (ms since the epoch) and its line of text. */
export type Notice = Note & { at: number; text: string };

/** One commit, as `run` reports it. */
export type CommitReport = {
  kind: "children" | "batch" | "follow" | "block" | "revert" | "done";
  ms: number;
  /** Of `ms`: the app's tables, and the cache. */
  tables: number;
  cache: number;
  /** After the commit. */
  checkpoint: number | undefined;
  /** A live block: its timestamp, events, and children created in it. */
  block?: { number: number; timestamp: number; events: number; children: number };
};

/**
 * What a run is doing, updated in place by `run`: read it whenever (the dev screen draws it 4 times a second).
 * What happens once (reorgs, class changes, phase summaries, progress) goes to `subscribe` listeners, in order.
 */
export class Status {
  phase: Phase = "starting";
  readonly started = performance.now();
  phaseStarted = performance.now();
  /** The run's error, in phase "failed". */
  error = "";
  schema = "";
  endpoint = "";
  tip = 0;
  factories = 0;
  /** Addresses watched (contracts and factory children) and children among them, read from the run's sources. */
  watched = (): { contracts: number; children: number } => ({ contracts: 0, children: 0 });
  /** Blocks of the current phase (factories or backfill): `first..to`, done through `through`. */
  range = { first: 0, to: 0, through: 0 };
  /** The last block committed. */
  checkpoint = 0;
  /** Events and block handlers handled. */
  handled = 0;
  readonly handlers = new Map<string, { count: number; ms: number }>();
  /**
   * Milliseconds spent waiting for events (`fetch`), for their headers, transactions and receipts (`extras`), in
   * handlers and committing (backfill and live).
   */
  readonly time = { fetch: 0, extras: 0, handlers: 0, commit: 0 };
  lastCommit = { ms: 0, tables: 0, cache: 0 };
  keys = { tables: 0, indexes: 0 };
  live = { block: 0, timestamp: 0, events: 0, at: 0, reorgs: 0 };
  api = "";
  rpc?: RpcStats;
  rate = () => 0;
  /** Each RPC endpoint's rate, calls and failures, when there are several. */
  endpoints = (): EndpointStats[] => [];
  cache?: { cachedEvents: number; fetchedEvents: number };
  calls?: { calls: number; cached: number };
  /** `--debug`: the fetcher's state and event loop delay on the screen. */
  debug = false;
  /** The backfill fetcher's state, while one runs. */
  fetcher?: () => FetchGauges;
  /** The newest head the WebSocket announced, and when it arrived (ms since the epoch). */
  head?: () => { number: number; timestamp: number; at: number } | undefined;
  readonly #rpcSamples: Sample[] = [];
  #lag: ReturnType<typeof monitorEventLoopDelay> | undefined;
  #lastLag: { max: number; p50: number } | undefined;
  /** Events handled per second, one point per 2 s, oldest first. */
  readonly history: number[] = [];
  readonly #samples: { t: number; through: number; handled: number }[] = [];
  #bucket = { t: performance.now(), handled: 0 };
  #phaseStart = { through: 0 };
  #handledAtPhase = 0;
  readonly #listeners = new Set<(n: Notice) => void>();

  /** Samples once a second (call it often), and returns the last minute's activity. */
  recent(now = performance.now()): Recent {
    const s = this.#rpcSamples;
    if (this.debug && this.#lag === undefined) {
      this.#lag = monitorEventLoopDelay({ resolution: LAG_RESOLUTION_MS });
      this.#lag.enable();
    }
    if (s.length === 0 || now - s.at(-1)!.t >= 1000) {
      const r = this.rpc;
      s.push({
        t: now,
        calls: r?.calls ?? 0,
        throttled: r?.throttled ?? 0,
        timeouts: r?.timeouts ?? 0,
        failed: r?.failed ?? 0,
        events: this.time.fetch,
        extras: this.time.extras,
      });
      while (s.length > 61) s.shift();
      if (this.#lag !== undefined) {
        // The histogram measures whole timer intervals: the delay is what goes past the resolution.
        const past = (ns: number) => Math.max(0, ns / 1e6 - LAG_RESOLUTION_MS);
        this.#lastLag = { max: past(this.#lag.max), p50: past(this.#lag.percentile(50)) };
        this.#lag.reset();
      }
    }
    const last = s.at(-1)!;
    const minute = s[0]!;
    const short = s[Math.max(0, s.length - 6)]!;
    const span = last.t - short.t;
    return {
      callsPerSecond: span > 0 ? ((last.calls - short.calls) / span) * 1000 : 0,
      throttled: last.throttled - minute.throttled,
      timeouts: last.timeouts - minute.timeouts,
      failed: last.failed - minute.failed,
      waitingEvents: span > 0 ? (last.events - short.events) / span : 0,
      waitingExtras: span > 0 ? (last.extras - short.extras) / span : 0,
      lag: this.#lastLag,
    };
  }

  get contracts(): number {
    return this.watched().contracts;
  }

  get children(): number {
    return this.watched().children;
  }

  enter(phase: Phase) {
    this.phase = phase;
    this.phaseStarted = performance.now();
    this.#handledAtPhase = this.handled;
    this.#samples.length = 0;
  }

  fail(err: unknown) {
    this.error = err instanceof Error ? err.message : String(err);
    this.enter("failed");
  }

  /** Calls `listener` with every notice from now on, in order. Returns the unsubscribe. */
  subscribe(listener: (n: Notice) => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  note(note: Note): void {
    const notice: Notice = { ...note, at: Date.now(), text: describe(note) };
    for (const l of this.#listeners) {
      // A broken printer must not stop the indexing, nor leave a commit half applied.
      try {
        l(notice);
      } catch (err) {
        console.error(err);
      }
    }
  }

  /** Moves the checkpoint, the commit times and the live block, and notes a progress line when one is due. */
  committed(r: CommitReport): void {
    this.time.commit += r.ms;
    if (r.checkpoint !== undefined) this.checkpoint = r.checkpoint;
    if (r.kind === "revert") this.live.reorgs++;
    if (r.kind === "batch") {
      this.lastCommit = { ms: r.ms, tables: r.tables, cache: r.cache };
      const { first, to } = this.range;
      const handled = this.handled - this.#handledAtPhase;
      const seconds = secondsSince(this.phaseStarted);
      this.note({
        kind: "progress",
        phase: "backfill",
        through: this.checkpoint,
        first,
        to,
        handled,
        seconds,
        ms: r.ms,
        tables: r.tables,
        cache: this.cache === undefined ? undefined : r.cache,
      });
    } else if (r.kind === "block" && r.block !== undefined) {
      const b = r.block;
      this.lastCommit = { ms: r.ms, tables: r.tables, cache: r.cache };
      this.live = {
        ...this.live,
        block: b.number,
        timestamp: b.timestamp,
        events: b.events,
        at: Date.now(),
      };
      this.tip = Math.max(this.tip, b.number);
      if (b.events > 0 || b.children > 0)
        this.note({
          kind: "progress",
          phase: "live",
          block: b.number,
          events: b.events,
          children: b.children,
          behind: Date.now() / 1000 - b.timestamp,
        });
    }
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
    if (s.length === 0 || s.at(-1)!.through !== this.range.through || now - s.at(-1)!.t > 1000)
      s.push({ t: now, through: this.range.through, handled: this.handled });
    while (s.length > 2 && now - s[0]!.t > 30_000) s.shift();
    const a = s[0]!;
    const seconds = (now - a.t) / 1000;
    if (seconds < 2) return { blocks: 0, events: 0, left: undefined, range: undefined };
    const blocks = (this.range.through - a.through) / seconds;
    const events = (this.handled - a.handled) / seconds;
    const remaining = this.range.to - this.range.through;
    const left = blocks > 0 ? remaining / blocks : undefined;
    const average =
      (this.range.through - this.#phaseStart.through) / ((now - this.phaseStarted) / 1000);
    const overall = average > 0 ? remaining / average : undefined;
    const range =
      left === undefined || overall === undefined
        ? undefined
        : ([Math.min(left, overall), Math.max(left, overall)] as [number, number]);
    return { blocks, events, left, range };
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const seconds = (s: number) => `${s.toFixed(1)}s`;

/** Every note's line. */
function describe(n: Note): string {
  switch (n.kind) {
    case "rebuild":
      return "build changed (config, tables or handlers): indexing from scratch";
    case "api":
      return `API on ${n.url}: GraphiQL at ${n.url}/graphql, POST /sql, POST /graphql, GET /live, GET /status, GET /health, GET /ready`;
    case "clamped":
      return `--to ${n.to} is past block ${n.through}, the last one that can't be reorged (head ${n.tip} minus ${n.window}): indexing to ${n.through}`;
    case "endpoint":
      return `${n.node} endpoint, spec ${n.spec}, tip ${n.tip}; ${plural(n.contracts, "contract")}${n.factories > 0 ? `, ${plural(n.factories, "factory", "factories")}` : ""}${n.blockSources > 0 ? `, ${plural(n.blockSources, "block source")}` : ""}`;
    case "reorg": {
      const undone = `${n.rows} row changes undone${n.children > 0 ? `, ${n.children} children forgotten` : ""}`;
      return n.stopped
        ? `reorg while stopped: block ${n.block} replaced, back to ${n.ancestor}: ${undone}`
        : `reorg: block ${n.block} (${n.hash}) replaced, back to ${n.ancestor}: ${undone}`;
    }
    case "class":
      return `${n.contract} ${n.address}: class replaced at block ${n.changes.map((c) => `${c.block} (${c.classHash})`).join(", ")}`;
    case "skipped":
      return `${n.contract}: events not in the configured ABI are skipped: ${n.events.join(", ")} (first in class ${n.classHash})`;
    case "socket":
      return n.state === "on"
        ? "WebSocket: following new heads"
        : n.state === "refused"
          ? `WebSocket: subscribeNewHeads refused (${n.reason}), polling instead`
          : n.state === "reconnected"
            ? "WebSocket: reconnected"
            : "WebSocket: closed, polling until it reconnects";
    case "factories":
      return `factories: ${n.children} children up to block ${n.through} in ${seconds(n.seconds)}`;
    case "backfill": {
      const reads = n.reads + n.cachedReads;
      return `backfill done: ${n.handled} handled in ${seconds(n.seconds)}${n.cache === undefined ? "" : ` (${n.cache.cachedEvents} events from the cache, ${n.cache.fetchedEvents} fetched)`}${reads === 0 ? "" : `, ${reads} contract reads (${n.cachedReads} cached)`}${n.rpc === undefined ? "" : `; rpc ${n.rpc.calls} calls, ${n.rpc.throttled} throttled, ${n.rpc.rate} calls/s max`}`;
    }
    case "keys":
      return `${plural(n.keys, "primary key")} built, ${plural(n.indexes, "index", "indexes")} in place, in ${seconds(n.seconds)}`;
    case "following":
      return `following the head from block ${n.block}`;
    case "progress":
      return n.phase === "backfill"
        ? `block ${n.through}/${n.to} (${(((n.through - n.first + 1) / (n.to - n.first + 1)) * 100).toFixed(1)}%), ${n.handled} handled, ${Math.round(n.handled / n.seconds)}/s, commit ${Math.round(n.ms)} ms (tables ${Math.round(n.tables)}${n.cache === undefined ? "" : `, cache ${Math.round(n.cache)}`})`
        : `block ${n.block}: ${n.events} events${n.children > 0 ? `, ${n.children} new children` : ""}, ${n.behind.toFixed(1)}s after its timestamp`;
  }
}
