import { expect, test } from "vitest";
import { duration, render, Screen } from "../../src/cli/ui/dashboard.ts";
import { Status } from "../../src/indexer/status.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
/** The box's content, without its borders. */
const inside = (lines: string[]) => lines.slice(1, -1).map((l) => l.slice(2, -2).trimEnd());

test("durations", () => {
  expect([duration(4.4), duration(61), duration(3599), duration(3600 * 5 + 61)]).toEqual([
    "4s",
    "1m 01s",
    "59m 59s",
    "5h 01m",
  ]);
});

test("backfill: progress, recent pace, where the time goes, the slowest handlers first", () => {
  const s = new Status();
  s.schema = "app";
  s.endpoint = "pathfinder 0.10";
  s.tip = 2_000_000;
  s.watched = () => ({ contracts: 1, children: 0 });
  s.enter("backfill");
  s.setRange(0, 1000, 100);
  const t0 = s.phaseStarted;
  s.pace(t0);
  s.range.through = 400;
  for (let i = 0; i < 300; i++) s.record("Pool:Swap", 0.01);
  s.record("Pool:Created", 5);
  s.time.fetch = 8000;
  s.time.commit = 1000;
  s.rpc = {
    requests: 30,
    calls: 900,
    retries: 0,
    throttled: 0,
    timeouts: 0,
    failed: 0,
    bytes: 0,
    methods: {
      starknet_getEvents: 400,
      starknet_blockNumber: 300,
      starknet_getClassHashAt: 100,
      starknet_getBlockWithTxHashes: 90,
      starknet_call: 10,
    },
  };
  const lines = render(s, { width: 100, now: t0 + 10_000 });
  for (const l of lines) expect(l.length).toBe(100);
  expect(lines[0]).toMatch(/^╭─ kasbah · app ─+ \[BACKFILL\] ─╮$/);
  const text = inside(lines).join("\n");
  expect(text).toContain("pathfinder 0.10 · tip 2,000,000 · 1 contract ");
  // 300 blocks in 10 s, 600 left: 20 s, the same as the phase's average.
  expect(text).toMatch(/block 400 \/ 1,000 +~20s left/);
  expect(text).toMatch(/40\.1%/);
  expect(text).toMatch(/events 89% {2}■ handlers 0% {2}■ commits 11%/);
  expect(text).toContain("bound by fetching");
  expect(text).toMatch(/getEvents 400 · blockNumber 300 · getClassHashAt 100 · \+2 more/);
  const rows = inside(lines).filter((l) => l.startsWith("Pool:"));
  expect(rows[0]).toMatch(/^Pool:Created\s+1\s+5\.0 ms\s+63%/);
  expect(rows[1]).toMatch(/^Pool:Swap\s+300\s+10 µs\s+37%/);
});

test("a pace that varies gives a range of time left", () => {
  const s = new Status();
  s.enter("backfill");
  s.setRange(0, 100_000, 0);
  const t0 = s.phaseStarted;
  // Slow at first, then 10 times faster for the last 30 s.
  s.range.through = 1000;
  s.pace(t0 + 60_000);
  s.range.through = 31_000;
  const text = inside(render(s, { now: t0 + 90_000 })).join("\n");
  // Recent: 30,000 blocks in 30 s, 69,000 left: 1m 09s. Average: 31,000 in 90 s: 3m 20s.
  expect(text).toMatch(/1m 09s – 3m 20s left \(varies with event density\)/);
});

test("live, done and stopped", () => {
  const s = new Status();
  s.enter("live");
  s.live = { block: 1234, timestamp: Date.now() / 1000 - 3, events: 7, at: Date.now(), reorgs: 1 };
  const live = inside(render(s)).join("\n");
  expect(live).toMatch(/block 1,234 · 3\.\ds behind the chain +last block 0s ago, 7 events/);
  expect(live).toMatch(/reorgs\s+1/);
  s.enter("done");
  expect(render(s)[0]).toContain("[DONE]");
  expect(inside(render(s)).join("\n")).toMatch(/✓ through block/);
  s.checkpoint = 1234;
  s.enter("stopped");
  expect(render(s)[0]).toContain("[STOPPED]");
  expect(inside(render(s)).join("\n")).toMatch(/■ stopped · committed through block 1,234 ·/);
  s.fail(new Error("the node refused"));
  expect(inside(render(s)).join("\n")).toMatch(/✗ the node refused · committed through block/);
});

test("colors don't change the layout", () => {
  const s = new Status();
  s.enter("backfill");
  s.setRange(0, 10, 5);
  s.record("A:b", 1);
  // One clock for both, and the process's memory masked: it moves between two renders (84 MB, then 83 MB).
  const now = performance.now();
  const same = (l: string) => l.replace(/\d+ MB/, "N MB");
  const colored = render(s, { width: 80, color: true, now });
  expect(colored.some((l) => l.includes("\x1b["))).toBe(true);
  expect(colored.map((l) => same(plain(l)))).toEqual(
    render(s, { width: 80, now }).map((l) => same(l.replace("[BACKFILL]", " BACKFILL "))),
  );
});

test("the screen redraws in place, with notices and console output above it", async () => {
  let written = "";
  const out = {
    columns: 60,
    write: (c: string) => {
      written += c;
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  const s = new Status();
  const screen = new Screen(s, out);
  screen.start();
  const drawn = (written.match(/\n/g) ?? []).length;
  s.note({ kind: "following", block: 5 });
  s.note({ kind: "progress", phase: "live", block: 6, events: 1, children: 0, behind: 1 });
  console.log("from a handler %d", 7);
  await new Promise((r) => setImmediate(r));
  const frames = written.split(/\x1b\[(\d+)F\x1b\[J/);
  expect(frames.length).toBe(3);
  expect(Number(frames[1])).toBe(drawn);
  expect(
    plain(frames[2]!).startsWith("[kasbah] following the head from block 5\nfrom a handler 7\n"),
  ).toBe(true);
  console.log("late");
  screen.stop();
  const before = written;
  s.note({ kind: "following", block: 8 });
  await new Promise((r) => setImmediate(r));
  expect(written.slice(before.length)).toBe("[kasbah] following the head from block 8\n");
  for (const line of plain(written).split("\n")) expect(line.length).toBeLessThanOrEqual(60);
});

test("rpc: calls per second now against the limit, and the last minute's throttles, timeouts and failures", () => {
  const s = new Status();
  s.enter("backfill");
  s.setRange(0, 1000, 0);
  const t0 = performance.now();
  s.rpc = {
    requests: 0,
    calls: 0,
    retries: 0,
    throttled: 0,
    timeouts: 0,
    failed: 0,
    bytes: 0,
    methods: {},
  };
  s.rate = () => 500;
  s.recent(t0);
  let text = inside(render(s, { now: t0 + 500 })).join("\n");
  expect(text).toContain("last minute: no throttling, timeouts or failed requests");
  Object.assign(s.rpc, { calls: 2_500, retries: 4, throttled: 3, timeouts: 1 });
  text = inside(render(s, { now: t0 + 5_000 })).join("\n");
  expect(text).toMatch(/500\/s now of 500 calls\/s max · at the limit/);
  expect(text).toContain("last minute: 3 throttled · 1 timeouts · 0 failed");
});

test("rpc: with several endpoints, a line each with its calls, limit, latency and troubles", () => {
  const s = new Status();
  s.enter("backfill");
  s.setRange(0, 1000, 0);
  s.rpc = {
    requests: 0,
    calls: 0,
    retries: 0,
    throttled: 0,
    timeouts: 0,
    failed: 0,
    bytes: 0,
    methods: {},
  };
  s.endpoints = () => [
    {
      host: "a.example",
      rate: 200,
      calls: 1_200,
      throttled: 0,
      failed: 0,
      latencyMs: 90,
      headersMs: 60,
    },
    {
      host: "b.example",
      rate: 10,
      calls: 80,
      throttled: 3,
      failed: 1,
      latencyMs: 400,
      headersMs: 380,
    },
  ];
  const text = inside(render(s, { width: 110 })).join("\n");
  expect(text).toContain("a.example · 1,200 calls · 200/s max · 90 ms");
  expect(text).toContain("b.example · 80 calls · 10/s max · 400 ms · 3 throttled · 1 failed");
});

test("--debug shows how long the endpoint took to its headers and with the body read; one endpoint gets no host line", () => {
  const s = new Status();
  s.enter("backfill");
  s.setRange(0, 1000, 0);
  s.debug = true;
  s.endpoints = () => [
    {
      host: "a.example",
      rate: 200,
      calls: 1_200,
      throttled: 0,
      failed: 0,
      latencyMs: 2400,
      headersMs: 750,
    },
  ];
  const text = inside(render(s, { width: 110 })).join("\n");
  expect(text).toContain("answers  750 ms to headers · 2400 ms with the body read (a.example)");
  expect(text).not.toContain("1,200 calls · 200/s max");
});

test("--debug shows the recent read-back queries, and the workers' time only once it's measured", () => {
  const s = new Status();
  s.enter("backfill");
  s.setRange(0, 1000, 0);
  s.debug = true;
  s.reads = () => ({ count: 42, slowestMs: 12.4 });
  s.fetcher = () => ({
    bufferedBytes: 0,
    maxBufferedBytes: 1,
    bufferedEvents: 0,
    written: 10,
    windows: 1,
    running: 1,
    paused: 0,
    done: 0,
    workers: 1,
    idleWorkers: 0,
    workerTime: undefined,
  });
  const text = inside(render(s, { width: 110 })).join("\n");
  expect(text).toContain("reads    42 read-back queries · slowest 12 ms (last 5 s)");
  expect(text).not.toContain("in getEvents");
});

test("the time bar splits waiting for events from waiting for headers; --debug shows the fetcher", () => {
  const s = new Status();
  s.enter("backfill");
  s.setRange(0, 1000, 0);
  Object.assign(s.time, { fetch: 1000, extras: 8000, handlers: 500, commit: 500 });
  s.debug = true;
  s.fetcher = () => ({
    bufferedBytes: 50 * 2 ** 20,
    maxBufferedBytes: 200 * 2 ** 20,
    bufferedEvents: 41_000,
    written: 123_456,
    windows: 40,
    running: 30,
    paused: 6,
    done: 4,
    workers: 32,
    idleWorkers: 2,
    workerTime: { calls: 0.25, room: 0.1, idle: 0.05 },
  });
  const text = inside(render(s, { width: 110 })).join("\n");
  expect(text).toMatch(/events 10% {2}■ headers\/txs 80% {2}■ handlers 5%/);
  expect(text).toContain("bound by fetching headers and transactions");
  expect(text).toMatch(
    /writing +50 MB \/ 200 MB · 41\.0k events waiting for Postgres \(25%\) · written through 123,456/,
  );
  expect(text).toContain("30 running · 6 paused · 4 done, not written (40) · 2 of 32 workers idle");
  expect(text).toContain(
    "25% in getEvents · 10% waiting for Postgres · 5% idle · 60% between calls (last 5 s)",
  );
});

test("live: the delay behind the chain, split between the node and us", () => {
  const s = new Status();
  s.enter("live");
  const now = Date.now();
  s.live = { block: 10, timestamp: Math.floor(now / 1000) - 5, events: 1, at: now, reorgs: 0 };
  s.head = () => ({ number: 10, timestamp: s.live.timestamp, at: now - 40 });
  const text = inside(render(s)).join("\n");
  expect(text).toMatch(
    /delay +\d\.\ds block timestamp → node announced it · 40\.0 ms announced → committed/,
  );
});

test("stopped before the first block: says so instead of a checkpoint of 0", () => {
  const s = new Status();
  s.enter("stopped");
  expect(inside(render(s)).join("\n")).toMatch(/■ stopped before indexing started/);
});
