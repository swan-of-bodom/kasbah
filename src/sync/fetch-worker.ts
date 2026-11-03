import { parentPort, workerData } from "node:worker_threads";
import pg from "pg";
import { EventCache } from "../db/cache.ts";
import { RpcClient, type RpcStats } from "../rpc/client.ts";
import { eventStream, type FetchGauges } from "./fetch.ts";
import { STATS_MS, type ThreadJob, type ThreadMessage } from "./fetch-thread.ts";

/** Connections the thread's pool opens: the writer writes one batch at a time. */
const POOL_SIZE = 1;

const job = workerData as ThreadJob;
const post = (m: ThreadMessage) => parentPort!.postMessage(m);
// The main thread stops it with `terminate()`: a write cut short rolls back with its coverage.
const rpc = new RpcClient(job.endpoints, { maxConcurrency: job.concurrency });
const pool = new pg.Pool({ connectionString: job.database, max: POOL_SIZE });
let gauges: (() => FetchGauges) | undefined;
let sent: RpcStats = { ...rpc.stats, methods: {} };
let fetched = 0;
let cache: EventCache | undefined;

/** What changed since the last report: counts as differences, so the main thread adds them to its own. */
function report() {
  const now = rpc.stats;
  const methods: Record<string, number> = {};
  for (const [m, n] of Object.entries(now.methods)) {
    const d = n - (sent.methods[m] ?? 0);
    if (d > 0) methods[m] = d;
  }
  const f = cache?.stats.fetchedEvents ?? 0;
  post({
    kind: "stats",
    rpc: {
      requests: now.requests - sent.requests,
      calls: now.calls - sent.calls,
      retries: now.retries - sent.retries,
      throttled: now.throttled - sent.throttled,
      timeouts: now.timeouts - sent.timeouts,
      failed: now.failed - sent.failed,
      bytes: now.bytes - sent.bytes,
      methods,
    },
    fetched: f - fetched,
    rate: rpc.rate,
    endpoints: rpc.endpoints,
    gauges: gauges?.(),
  });
  sent = { ...now, methods: { ...now.methods } };
  fetched = f;
}

const timer = setInterval(report, STATS_MS);
try {
  cache = EventCache.attach(pool, job.chainId);
  const stream = eventStream({
    rpc,
    address: job.addresses,
    keys: job.keys,
    from: job.from,
    to: job.to,
    chunkSize: job.chunkSize,
    concurrency: job.concurrency,
    ranges: job.ranges,
    store: cache.writer(job.addresses, job.keys[0]!),
    gauges: (read) => (gauges = read),
  });
  for await (const { through } of stream) post({ kind: "through", through });
  report();
  post({ kind: "done" });
} catch (e) {
  report();
  const error = e instanceof Error ? e : new Error(String(e));
  post({ kind: "error", name: error.name, message: error.message, stack: error.stack });
} finally {
  clearInterval(timer);
  await pool.end();
}
