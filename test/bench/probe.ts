import { writeFileSync } from "node:fs";
import { constants, PerformanceObserver } from "node:perf_hooks";

const out = process.env.KASBAH_BENCH_OUT!;
const TICK_MS = 10;
const gaps: number[] = [];
let last = performance.now();
setInterval(() => {
  const now = performance.now();
  if (now - last - TICK_MS > 100) gaps.push(now - last - TICK_MS);
  last = now;
}, TICK_MS).unref();

// Time to response headers of each RPC request: how fast the node answered, whatever kasbah did meanwhile.
const rpcMs: number[] = [];
const fetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const t = performance.now();
  const res = await fetch(input, init);
  if (init?.method === "POST") rpcMs.push(performance.now() - t);
  return res;
};
let gcMs = 0;
const kinds: Record<number, string> = {
  [constants.NODE_PERFORMANCE_GC_MAJOR]: "major",
  [constants.NODE_PERFORMANCE_GC_MINOR]: "minor",
  [constants.NODE_PERFORMANCE_GC_INCREMENTAL]: "incremental",
  [constants.NODE_PERFORMANCE_GC_WEAKCB]: "weakcb",
};
const gc: Record<string, { count: number; seconds: number }> = {};
new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    gcMs += e.duration;
    const k = kinds[(e as PerformanceEntry & { detail: { kind: number } }).detail.kind] ?? "other";
    gc[k] ??= { count: 0, seconds: 0 };
    gc[k].count++;
    gc[k].seconds += e.duration / 1000;
  }
}).observe({ entryTypes: ["gc"] });

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

process.on("exit", () => {
  writeFileSync(
    out,
    JSON.stringify({
      maxRssMb: process.resourceUsage().maxRSS / 1024,
      gaps: gaps.length,
      gapsOver400: gaps.filter((g) => g > 400).length,
      gapSeconds: gaps.reduce((a, g) => a + g, 0) / 1000,
      maxGapMs: Math.max(0, ...gaps),
      cpuSeconds: (process.cpuUsage().user + process.cpuUsage().system) / 1e6,
      systemSeconds: process.cpuUsage().system / 1e6,
      rpcMedianMs: median(rpcMs),
      gcSeconds: gcMs / 1000,
      gc,
    }),
  );
});
