import { expect, test } from "vitest";
import { duration, render, Screen } from "../src/dashboard.ts";
import { Status } from "../src/status.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("durations", () => {
  expect([duration(4.4), duration(61), duration(3599), duration(3600 * 5 + 61)]).toEqual(["4s", "1m 01s", "59m 59s", "5h 01m"]);
});

test("backfill: progress from recent pace, where the time goes, the slowest handlers first", () => {
  const s = new Status();
  s.schema = "app";
  s.endpoint = "pathfinder 0.10";
  s.tip = 2_000_000;
  s.enter("backfill");
  s.range = { first: 0, to: 1000, through: 100 };
  const t0 = performance.now();
  s.pace(t0);
  s.range.through = 400;
  for (let i = 0; i < 300; i++) s.record("Pool:Swap", 0.01);
  s.record("Pool:Created", 5);
  s.time.fetch = 8000;
  s.time.commit = 1000;
  const lines = render(s, t0 + 10_000);
  const text = lines.join("\n");
  // 300 blocks in 10 s, 600 left: about 20 s.
  expect(text).toContain("40.1%  block 400 / 1,000  ~20s left");
  expect(text).toContain("30 events/s now");
  expect(text).toMatch(/waiting for events 89% · handlers 0% · commits 11% · bound by fetching/);
  const handlers = lines.filter((l) => l.includes("Pool:"));
  expect(handlers[0]).toMatch(/^handlers\s+Pool:Created\s+1\s+5\.0 ms avg\s+63%$/);
  expect(handlers[1]).toMatch(/^\s+Pool:Swap\s+300\s+10 µs avg\s+37%$/);
});

test("live and done", () => {
  const s = new Status();
  s.enter("live");
  s.live = { block: 1234, timestamp: Date.now() / 1000 - 3, events: 7, at: Date.now(), reorgs: 1 };
  expect(render(s).join("\n")).toMatch(/live\s+block 1,234 · 3\.\ds behind its timestamp · last block 0s ago, 7 events · 1 reorg$/m);
  s.enter("done");
  expect(render(s).join("\n")).toMatch(/^done\s+through block/m);
});

test("the screen redraws in place, with log lines and console output above it", () => {
  let written = "";
  const out = { columns: 60, write: (c: string) => ((written += c), true) } as unknown as NodeJS.WriteStream;
  const s = new Status();
  const screen = new Screen(s, out);
  screen.start();
  const drawn = (written.match(/\n/g) ?? []).length;
  screen.log("hello");
  console.log("from a handler %d", 7);
  screen.stop();
  const frames = written.split(/\x1b\[(\d+)F\x1b\[J/);
  // Each redraw moves up exactly the lines drawn before it.
  expect(Number(frames[1])).toBe(drawn);
  expect(plain(frames[2]!).startsWith("[kasbah] hello\n")).toBe(true);
  expect(plain(frames[4]!).startsWith("from a handler 7\n")).toBe(true);
  // Console is back to normal after stop.
  expect(console.log.toString()).not.toContain("#print");
  for (const line of plain(written).split("\n")) expect(line.length).toBeLessThanOrEqual(60);
});
