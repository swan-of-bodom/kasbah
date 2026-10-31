import { expect, test } from "vitest";
import type { RpcClient } from "../../src/rpc/client.ts";
import type { EmittedEvent, EventFilter } from "../../src/rpc/methods.ts";
import { eventStream, type FetchGauges, fetchEvents } from "../../src/sync/fetch.ts";
import { approxBytes, heapLimit } from "../../src/utils/memory.ts";

/** A Pathfinder-like node: pages of `chunk` events, at most `scanLimit` blocks per call, token `"<block>-<matched skipped>"`. */
function fakeNode(events: EmittedEvent[], scanLimit: number) {
  let calls = 0;
  const byBlock = new Map<number, EmittedEvent[]>();
  for (const e of events)
    byBlock.set(e.block_number!, [...(byBlock.get(e.block_number!) ?? []), e]);
  const rpc = {
    async request(
      _method: string,
      params: { filter: EventFilter & { chunk_size: number; continuation_token?: string } },
    ) {
      calls++;
      await new Promise((r) => setTimeout(r, Math.random() * 2));
      const f = params.filter;
      const from = (f.from_block as { block_number: number }).block_number;
      const to = (f.to_block as { block_number: number }).block_number;
      let block = from;
      let skip = 0;
      if (f.continuation_token !== undefined)
        [block, skip] = f.continuation_token.split("-").map(Number) as [number, number];
      const scanEnd = Math.min(to, block + scanLimit - 1);
      const out: EmittedEvent[] = [];
      for (let b = block; b <= scanEnd; b++) {
        const inBlock = (byBlock.get(b) ?? []).slice(b === block ? skip : 0);
        for (const [i, e] of inBlock.entries()) {
          if (out.length === f.chunk_size) {
            const done = (b === block ? skip : 0) + i;
            return { events: out, continuation_token: `${b}-${done}` };
          }
          out.push(e);
        }
      }
      return scanEnd < to
        ? { events: out, continuation_token: `${scanEnd + 1}-0` }
        : { events: out };
    },
  };
  return { rpc: rpc as unknown as RpcClient, calls: () => calls };
}

function syntheticEvents(blocks: number, seed: number, felts = 0): EmittedEvent[] {
  let s = seed;
  const rand = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const out: EmittedEvent[] = [];
  for (let b = 0; b < blocks; b++) {
    // Dense and empty stretches, like a real contract's history.
    const density = b % 5000 < 1500 ? 0 : b % 5000 < 1600 ? 40 : 3;
    const n = Math.floor(rand() * density);
    for (let i = 0; i < n; i++) {
      out.push({
        from_address: "0x1",
        keys: [],
        data: Array.from({ length: felts }, (_, j) => `0x${(b * 64 + j).toString(16)}`),
        block_number: b,
        transaction_hash: "0x0",
        transaction_index: Math.floor(i / 4),
        event_index: i % 4,
      });
    }
  }
  return out;
}

const maxBytes = (events: EmittedEvent[]) => Math.max(...events.map(approxBytes));

test.each([
  { concurrency: 1, windowEvents: 256, maxBuffered: 100_000 },
  { concurrency: 4, windowEvents: 256, maxBuffered: 100_000 },
  { concurrency: 16, windowEvents: 64, maxBuffered: 100_000 },
  { concurrency: 32, windowEvents: 4096, maxBuffered: 100_000 },
  { concurrency: 16, windowEvents: 256, maxBuffered: 500 },
])("every event exactly once, in order: %o", async ({ concurrency, windowEvents, maxBuffered }) => {
  const events = syntheticEvents(20_000, concurrency);
  const eventBytes = maxBytes(events);
  const node = fakeNode(events, 2_048);
  const seen: string[] = [];
  const stats = await fetchEvents({
    rpc: node.rpc,
    address: "0x1",
    from: 0,
    to: 19_999,
    chunkSize: 64,
    concurrency,
    windowEvents,
    maxBufferedBytes: maxBuffered * eventBytes,
    onEvents(page) {
      for (const e of page) seen.push(`${e.block_number}:${e.transaction_index}:${e.event_index}`);
    },
  });
  expect(stats.events).toBe(events.length);
  expect(new Set(seen).size).toBe(events.length);
  expect(seen).toEqual(
    events.map((e) => `${e.block_number}:${e.transaction_index}:${e.event_index}`),
  );
  // Three budgets (see `mayFetch`), plus one page from each request in flight.
  expect(stats.peakBufferedBytes).toBeLessThanOrEqual(
    (3 * maxBuffered + concurrency * 64) * eventBytes,
  );
  if (concurrency > 1) expect(stats.splits).toBeGreaterThan(0);
});

test("the budget is in bytes: larger events, fewer of them held at once", async () => {
  const peaks = [];
  for (const felts of [0, 40]) {
    const events = syntheticEvents(20_000, 7, felts);
    const budget = 2_000 * maxBytes(syntheticEvents(20_000, 7, 0));
    let read: (() => FetchGauges) | undefined;
    let peakEvents = 0;
    const stats = await fetchEvents({
      rpc: fakeNode(events, 2_048).rpc,
      address: "0x1",
      from: 0,
      to: 19_999,
      chunkSize: 64,
      concurrency: 8,
      windowEvents: 256,
      maxBufferedBytes: budget,
      gauges: (r) => (read = r),
      onEvents() {
        peakEvents = Math.max(peakEvents, read!().bufferedEvents);
      },
    });
    expect(stats.events).toBe(events.length);
    expect(stats.peakBufferedBytes).toBeLessThanOrEqual(3 * budget + 8 * 64 * maxBytes(events));
    peaks.push(peakEvents);
  }
  expect(peaks[1]).toBeLessThan(peaks[0]! / 3);
});

test("without a budget, a fifteenth of the heap", async () => {
  let gauges: (() => FetchGauges) | undefined;
  const stream = eventStream({
    rpc: fakeNode([], 2_048).rpc,
    address: "0x1",
    from: 0,
    to: 10,
    chunkSize: 64,
    concurrency: 2,
    budgetShare: 0.5,
    gauges: (read) => (gauges = read),
  });
  for await (const _ of stream);
  expect(gauges!().maxBufferedBytes).toBe(
    Math.max(8 * 2 ** 20, Math.floor(heapLimit() * (1 / 15) * 0.5)),
  );
});

test("windows paused by the budget don't keep idle workers from the front", async () => {
  const BLOCKS = 40_000;
  const events: EmittedEvent[] = [];
  for (let b = 0; b < BLOCKS; b++)
    for (let i = 0; i < (b < BLOCKS / 2 ? (b % 40 === 0 ? 1 : 0) : 3); i++)
      events.push({
        from_address: "0x1",
        keys: [],
        data: [],
        block_number: b,
        transaction_hash: "0x0",
        transaction_index: i,
        event_index: 0,
      });
  const inner = fakeNode(events, BLOCKS).rpc as unknown as {
    request: (method: string, params: { filter: EventFilter }) => Promise<unknown>;
  };
  let requestMs = 0;
  const rpc = {
    async request(method: string, params: { filter: EventFilter }): Promise<unknown> {
      const t = performance.now();
      await new Promise((r) => setTimeout(r, 5));
      try {
        return await inner.request(method, params);
      } finally {
        requestMs += performance.now() - t;
      }
    },
  };
  const started = performance.now();
  const stats = await fetchEvents({
    rpc: rpc as unknown as RpcClient,
    address: "0x1",
    from: 0,
    to: BLOCKS - 1,
    chunkSize: 64,
    concurrency: 16,
    maxBufferedBytes: 6 * 16 * 64 * maxBytes(events),
    onEvents() {},
  });
  expect(stats.events).toBe(events.length);
  expect(requestMs / (performance.now() - started)).toBeGreaterThan(7);
}, 60_000);

test("after a dense start, cutting stops at the budget instead of splitting the whole range", async () => {
  const BLOCKS = 1_000_000;
  const events: EmittedEvent[] = [];
  for (let b = 0; b < BLOCKS; b++)
    if (b < 50_000 || b % 40 === 0)
      events.push({
        from_address: "0x1",
        keys: [],
        data: Array.from({ length: 20 }, (_, j) => `0x${(b + j).toString(16)}`),
        block_number: b,
        transaction_hash: "0x0",
        transaction_index: 0,
        event_index: 0,
      });
  let read: (() => FetchGauges) | undefined;
  let maxWindows = 0;
  const stats = await fetchEvents({
    rpc: fakeNode(events, BLOCKS).rpc,
    address: "0x1",
    from: 0,
    to: BLOCKS - 1,
    chunkSize: 1024,
    concurrency: 32,
    maxBufferedBytes: 4_000_000,
    gauges: (r) => (read = r),
    onEvents(page) {
      maxWindows = Math.max(maxWindows, read!().windows);
      const until = performance.now() + page.length * 0.02;
      while (performance.now() < until);
    },
  });
  expect(stats.events).toBe(events.length);
  expect(maxWindows).toBeLessThan(100);
}, 60_000);
