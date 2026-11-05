import { Worker } from "node:worker_threads";
import { ConfigError } from "../config/errors.ts";
import type { EventCache } from "../db/cache.ts";
import type { Status } from "../indexer/status.ts";
import type { EndpointStats, RpcClient, RpcEndpoint, RpcStats } from "../rpc/client.ts";
import { heapLimit } from "../utils/memory.ts";
import type { Batch, FetchGauges } from "./fetch.ts";

/** How often the fetch thread reports its RPC counts and gauges: often enough for the dashboard's second-by-second view. */
export const STATS_MS = 250;
/**
 * The fetch thread's heap, `share` of the indexer's: pages in flight and events waiting for Postgres, which the main
 * thread held before. It follows the heap the process is given, as every other limit does, and is at least `minMb`,
 * for a few pages in flight on the smallest heap.
 */
const FETCH_HEAP = { share: 1 / 4, minMb: 48 };
/**
 * Share of each endpoint's rate ceiling lent to the fetch thread: `getEvents` is most of a backfill's calls, and the
 * main thread keeps the rest for headers, transactions and calls.
 */
const FETCH_RATE_SHARE = 3 / 4;

/** What the fetch thread fetches into the cache, and how to reach the RPC and Postgres. */
export type ThreadJob = {
  endpoints: RpcEndpoint[];
  database: string;
  chainId: string;
  addresses: string[];
  keys: string[][];
  from: number;
  to: number;
  ranges: [number, number][];
  chunkSize: number;
  concurrency: number;
};

export type ThreadMessage =
  | { kind: "through"; through: number }
  | {
      kind: "stats";
      rpc: RpcStats;
      fetched: number;
      rate: number;
      endpoints: EndpointStats[];
      gauges: FetchGauges | undefined;
    }
  | { kind: "done" }
  | { kind: "error"; name: string; message: string; stack: string | undefined };

const WORKER = new URL(
  import.meta.url.endsWith(".ts") ? "./fetch-worker.ts" : "./fetch-worker.js",
  import.meta.url,
);

/**
 * `eventStream` with a store, run in a worker thread: it fetches the job's ranges into `cache` and yields how far the
 * cache has every block. The main thread then only reads events back and runs handlers; reading and parsing RPC
 * answers and writing them to Postgres, as much work again, happens on another core. The thread's RPC counts join
 * the main client's, so the dashboard and `/metrics` show both.
 */
export async function* fetchThread(
  host: {
    rpc: RpcClient;
    status: Status;
    cache: EventCache;
    database: string;
    /** Ends the thread at once, its writes cut short: the stream ends with what's written. */
    signal?: AbortSignal;
  },
  job: Omit<ThreadJob, "endpoints" | "database" | "chainId">,
): AsyncGenerator<Batch> {
  const { rpc, status, cache } = host;
  const lent = rpc.lend(FETCH_RATE_SHARE);
  const worker = new Worker(WORKER, {
    workerData: {
      ...job,
      endpoints: lent.endpoints,
      database: host.database,
      chainId: cache.chainId,
    } satisfies ThreadJob,
    resourceLimits: {
      maxOldGenerationSizeMb: Math.max(
        FETCH_HEAP.minMb,
        Math.floor((heapLimit() / 2 ** 20) * FETCH_HEAP.share),
      ),
    },
  });
  let through = job.from - 1;
  let ended: "done" | Error | undefined;
  let wake: (() => void) | undefined;
  let theirs: Extract<ThreadMessage, { kind: "stats" }> | undefined;
  const { endpoints, rate } = status;
  status.endpoints = () =>
    rpc.endpoints.map((e, i) => {
      const t = theirs?.endpoints[i];
      if (t === undefined) return e;
      return {
        ...e,
        rate: e.rate + t.rate,
        calls: e.calls + t.calls,
        throttled: e.throttled + t.throttled,
        failed: e.failed + t.failed,
        latencyMs: t.latencyMs || e.latencyMs,
        headersMs: t.headersMs || e.headersMs,
      };
    });
  status.rate = () => rpc.rate + (theirs?.rate ?? 0);
  const stop = () => {
    ended ??= "done";
    void worker.terminate();
    wake?.();
  };
  host.signal?.addEventListener("abort", stop, { once: true });
  if (host.signal?.aborted) stop();
  worker.on("message", (m: ThreadMessage) => {
    if (m.kind === "through") through = m.through;
    else if (m.kind === "stats") {
      theirs = m;
      add(rpc.stats, m.rpc);
      cache.stats.fetchedEvents += m.fetched;
      if (m.gauges !== undefined) {
        const gauges = m.gauges;
        status.fetcher = () => gauges;
      }
    } else if (m.kind === "done") ended ??= "done";
    else ended ??= rebuilt(m);
    wake?.();
  });
  worker.on("error", (e) => {
    ended ??= e;
    wake?.();
  });
  worker.on("exit", (code) => {
    ended ??= new Error(`the fetch thread exited with code ${code}`);
    wake?.();
  });
  let yielded = through;
  try {
    for (;;) {
      if (through > yielded) {
        yielded = through;
        yield { events: [], through };
      } else if (ended instanceof Error) throw ended;
      else if (ended === "done") return;
      else await new Promise<void>((r) => (wake = r));
    }
  } finally {
    host.signal?.removeEventListener("abort", stop);
    await worker.terminate();
    lent.repay();
    status.endpoints = endpoints;
    status.rate = rate;
    status.fetcher = undefined;
  }
}

function add(to: RpcStats, d: RpcStats) {
  to.requests += d.requests;
  to.calls += d.calls;
  to.retries += d.retries;
  to.throttled += d.throttled;
  to.timeouts += d.timeouts;
  to.failed += d.failed;
  to.bytes += d.bytes;
  for (const [m, n] of Object.entries(d.methods)) to.methods[m] = (to.methods[m] ?? 0) + n;
}

/** The thread's error on this side: a `ConfigError` stays one, so the CLI prints it without a stack. */
function rebuilt(m: Extract<ThreadMessage, { kind: "error" }>): Error {
  const e = m.name === "ConfigError" ? new ConfigError(m.message) : new Error(m.message);
  e.name = m.name;
  if (m.stack !== undefined) e.stack = m.stack;
  return e;
}
