import { writeFileSync } from "node:fs";

const out = process.env.KASBAH_BENCH_OUT!;
const TICK_MS = 10;
const gaps: number[] = [];
let last = performance.now();
setInterval(() => {
  const now = performance.now();
  if (now - last - TICK_MS > 100) gaps.push(now - last - TICK_MS);
  last = now;
}, TICK_MS).unref();

process.on("exit", () => {
  writeFileSync(
    out,
    JSON.stringify({
      maxRssMb: process.resourceUsage().maxRSS / 1024,
      gaps: gaps.length,
      gapsOver400: gaps.filter((g) => g > 400).length,
      gapSeconds: gaps.reduce((a, g) => a + g, 0) / 1000,
      maxGapMs: Math.max(0, ...gaps),
    }),
  );
});
