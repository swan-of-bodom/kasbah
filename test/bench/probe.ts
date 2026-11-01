import { writeFileSync } from "node:fs";
import { PerformanceObserver } from "node:perf_hooks";

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
new PerformanceObserver((list) => {
  for (const e of list.getEntries()) gcMs += e.duration;
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
      rpcMedianMs: median(rpcMs),
      gcSeconds: gcMs / 1000,
    }),
  );
});
