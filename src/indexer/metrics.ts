import { monitorEventLoopDelay, PerformanceObserver, performance } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import { type Metric, prometheus, type Sample } from "../api/prometheus.ts";
import type { Status } from "./status.ts";

/** Since the last scrape: event loop delay and utilization. Since the first: time in garbage collection. */
let loop:
  | {
      delay: ReturnType<typeof monitorEventLoopDelay>;
      elu: ReturnType<typeof performance.eventLoopUtilization>;
      gcMs: number;
    }
  | undefined;

function processMetrics(): Metric[] {
  if (loop === undefined) {
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    loop = { delay, elu: performance.eventLoopUtilization(), gcMs: 0 };
    const l = loop;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) l.gcMs += e.duration;
    }).observe({ entryTypes: ["gc"] });
  }
  const elu = performance.eventLoopUtilization(loop.elu);
  loop.elu = performance.eventLoopUtilization();
  const d = loop.delay;
  // The histogram measures whole timer intervals: the delay is what goes past the resolution.
  const past = (ns: number) => Math.max(0, ns / 1e9 - 0.01);
  const delay: Metric = {
    name: "event_loop_delay_seconds",
    type: "gauge",
    help: "Event loop delay since the last scrape, by quantile.",
    samples:
      d.count === 0
        ? []
        : [
            [{ quantile: "0.5" }, past(d.percentile(50))],
            [{ quantile: "0.99" }, past(d.percentile(99))],
            [{ quantile: "1" }, past(d.max)],
          ],
  };
  d.reset();
  const heap = getHeapStatistics();
  return [
    one("heap_used_bytes", "gauge", "V8 heap in use.", heap.used_heap_size),
    one("heap_limit_bytes", "gauge", "V8 heap limit.", heap.heap_size_limit),
    one("rss_bytes", "gauge", "Resident memory of the process.", process.memoryUsage.rss()),
    one("gc_seconds_total", "counter", "Time in garbage collection.", loop.gcMs / 1000),
    one(
      "event_loop_utilization",
      "gauge",
      "Share of the time since the last scrape the event loop was busy.",
      elu.utilization,
    ),
    delay,
  ];
}

const one = (name: string, type: Metric["type"], help: string, value: number): Metric => ({
  name,
  type,
  help,
  samples: [[{}, value]],
});

/** What the indexer reports, for `/metrics`. */
export function metricsOf(status: Status): string {
  const rpc = status.rpc;
  const handlers = [...status.handlers];
  const head = status.head?.()?.number ?? status.tip;
  const f = status.fetcher?.();
  return prometheus([
    ...processMetrics(),
    ...(f === undefined
      ? []
      : [
          one(
            "fetch_buffered_bytes",
            "gauge",
            "Events fetched, not yet handled (estimated).",
            f.buffered,
          ),
          one("fetch_buffer_limit_bytes", "gauge", "The fetch buffer's budget.", f.maxBuffered),
          one(
            "fetch_buffered_events",
            "gauge",
            "Events fetched, not yet handled.",
            f.bufferedEvents,
          ),
          {
            name: "fetch_windows",
            type: "gauge" as const,
            help: "Fetch windows, by state.",
            samples: [
              [{ state: "running" }, f.running],
              [{ state: "paused" }, f.paused],
              [{ state: "done" }, f.done],
            ] satisfies Sample[],
          },
          one("fetch_idle_workers", "gauge", "Fetch workers with nothing to do.", f.idleWorkers),
        ]),
    {
      name: "phase",
      type: "gauge",
      help: "The phase running (1).",
      samples: [[{ phase: status.phase }, 1]],
    },
    one("checkpoint", "gauge", "Last block committed.", status.checkpoint),
    one("head", "gauge", "Newest block the node has, as last seen.", head),
    one(
      "live_block_timestamp_seconds",
      "gauge",
      "Timestamp of the last live block indexed.",
      status.live.timestamp,
    ),
    one("reorgs_total", "counter", "Reorgs undone.", status.live.reorgs),
    one("events_handled_total", "counter", "Events and block handlers run.", status.handled),
    one("watched_contracts", "gauge", "Addresses watched, children included.", status.contracts),
    one("watched_children", "gauge", "Factory children watched.", status.children),
    {
      name: "handler_calls_total",
      type: "counter",
      help: "Calls per handler.",
      samples: handlers.map(([h, s]) => [{ handler: h }, s.count]),
    },
    {
      name: "handler_seconds_total",
      type: "counter",
      help: "Time spent per handler.",
      samples: handlers.map(([h, s]) => [{ handler: h }, s.ms / 1000]),
    },
    {
      name: "seconds_total",
      type: "counter",
      help: "Time spent waiting, per part.",
      samples: Object.entries(status.time).map(([part, ms]) => [{ part }, ms / 1000]),
    },
    ...(rpc === undefined
      ? []
      : [
          one(
            "rpc_requests_total",
            "counter",
            "HTTP requests to the RPC (a batch is one).",
            rpc.requests,
          ),
          one("rpc_calls_total", "counter", "JSON-RPC calls.", rpc.calls),
          one("rpc_retries_total", "counter", "Calls retried.", rpc.retries),
          one("rpc_throttled_total", "counter", "Calls the node rate-limited.", rpc.throttled),
          one("rpc_timeouts_total", "counter", "Calls timed out.", rpc.timeouts),
          one("rpc_failed_total", "counter", "Calls that failed for good.", rpc.failed),
          one("rpc_bytes_total", "counter", "Bytes received.", rpc.bytes),
          {
            name: "rpc_method_calls_total",
            type: "counter" as const,
            help: "JSON-RPC calls per method.",
            samples: Object.entries(rpc.methods).map(([method, n]): Sample => [{ method }, n]),
          },
        ]),
    {
      name: "endpoint_calls_total",
      type: "counter",
      help: "Calls per endpoint, with several.",
      samples: status.endpoints().map((e) => [{ endpoint: e.host }, e.calls]),
    },
    {
      name: "endpoint_failed_total",
      type: "counter",
      help: "Failed calls per endpoint, with several.",
      samples: status.endpoints().map((e) => [{ endpoint: e.host }, e.failed]),
    },
    {
      name: "endpoint_latency_seconds",
      type: "gauge",
      help: "Recent mean latency per endpoint, with several.",
      samples: status.endpoints().map((e) => [{ endpoint: e.host }, e.latencyMs / 1000]),
    },
    ...(status.calls === undefined
      ? []
      : [
          one("contract_calls_total", "counter", "context.client reads.", status.calls.calls),
          one(
            "contract_calls_cached_total",
            "counter",
            "context.client reads served by the cache.",
            status.calls.cached,
          ),
        ]),
  ]);
}
