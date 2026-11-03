import { expect, test, vi } from "vitest";
import type { RpcClient } from "../../src/rpc/client.ts";
import type { EmittedEvent, EventFilter } from "../../src/rpc/methods.ts";
import {
  eventStream,
  type FetchGauges,
  fetchEvents,
  type PageStore,
} from "../../src/sync/fetch.ts";
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

test.each([1, 2, 5])(
  "with at most %i windows, every event still arrives once, in order",
  async (maxWindows) => {
    const events = syntheticEvents(20_000, maxWindows);
    let read: (() => FetchGauges) | undefined;
    let peak = 0;
    const seen: string[] = [];
    const stats = await fetchEvents({
      rpc: fakeNode(events, 2_048).rpc,
      address: "0x1",
      from: 0,
      to: 19_999,
      chunkSize: 16,
      concurrency: 8,
      windowEvents: 1,
      minSplit: 1,
      maxWindows,
      gauges: (r) => (read = r),
      onEvents(page) {
        peak = Math.max(peak, read!().windows);
        for (const e of page)
          seen.push(`${e.block_number}:${e.transaction_index}:${e.event_index}`);
      },
    });
    expect(peak).toBeLessThanOrEqual(maxWindows);
    expect(stats.events).toBe(events.length);
    expect(seen).toEqual(
      events.map((e) => `${e.block_number}:${e.transaction_index}:${e.event_index}`),
    );
  },
);

test("pages in flight count toward the budget: buffered plus downloading stays under 3x", async () => {
  const BLOCKS = 20_000;
  const events: EmittedEvent[] = [];
  for (let b = 0; b < BLOCKS; b++)
    for (let i = 0; i < 3; i++)
      events.push({
        from_address: "0x1",
        keys: [],
        data: Array.from({ length: 20 }, (_, j) => `0x${(b * 64 + j).toString(16)}`),
        block_number: b,
        transaction_hash: "0x0",
        transaction_index: i,
        event_index: 0,
      });
  const inner = fakeNode(events, BLOCKS).rpc as unknown as {
    request: (method: string, params: unknown) => Promise<unknown>;
  };
  let inFlight = 0;
  const rpc = {
    async request(method: string, params: unknown): Promise<unknown> {
      inFlight++;
      try {
        await new Promise((r) => setTimeout(r, 5));
        return await inner.request(method, params);
      } finally {
        inFlight--;
      }
    },
  };
  const pageBytes = 64 * maxBytes(events);
  const budget = 4 * pageBytes;
  let read: (() => FetchGauges) | undefined;
  let peak = 0;
  let total = 0;
  const watch = setInterval(
    () => (peak = Math.max(peak, (read?.().bufferedBytes ?? 0) + inFlight * pageBytes)),
    1,
  );
  for await (const batch of eventStream({
    rpc: rpc as unknown as RpcClient,
    address: "0x1",
    from: 0,
    to: BLOCKS - 1,
    chunkSize: 64,
    concurrency: 32,
    maxBufferedBytes: budget,
    gauges: (r) => (read = r),
  })) {
    total += batch.events.length;
    await new Promise((r) => setTimeout(r, 2));
  }
  clearInterval(watch);
  expect(total).toBe(events.length);
  expect(peak / budget).toBeLessThanOrEqual(3 + 2 / 4);
}, 60_000);

/** A store writing after a random delay, in the order given, with room for `max` events. */
function fakeStore(max = Number.POSITIVE_INFINITY, delayMs = 3) {
  const events: EmittedEvent[] = [];
  const ranges: [number, number][] = [];
  let held = 0;
  let peak = 0;
  let tail = Promise.resolve();
  const wakers: (() => void)[] = [];
  const store: PageStore = {
    write(page, from, to) {
      held += page.length;
      peak = Math.max(peak, held);
      tail = tail.then(async () => {
        await new Promise((r) => setTimeout(r, Math.random() * delayMs));
        events.push(...page);
        ranges.push([from, to]);
        held -= page.length;
        if (held < max) for (const w of wakers.splice(0)) w();
      });
      return tail;
    },
    room: () => (held < max ? Promise.resolve() : new Promise<void>((r) => wakers.push(r))),
    held: () => ({ bytes: held, events: held, max }),
  };
  /** Whether every block of `[from, to]` is written. */
  const covers = (from: number, to: number) => {
    const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
    let next = from;
    for (const [a, b] of sorted) if (a <= next && b >= next) next = b + 1;
    return next > to;
  };
  return { store, events, ranges, covers, peak: () => peak };
}

const id = (e: EmittedEvent) => `${e.block_number}:${e.transaction_index}:${e.event_index}`;

test.each([1, 4, 32])(
  "with a store, every event is written once, and no block is claimed before every block up to it is written: %i workers",
  async (concurrency) => {
    const events = syntheticEvents(20_000, concurrency);
    const s = fakeStore();
    let through = -1;
    for await (const batch of eventStream({
      rpc: fakeNode(events, 2_048).rpc,
      address: "0x1",
      from: 0,
      to: 19_999,
      chunkSize: 64,
      concurrency,
      windowEvents: 256,
      store: s.store,
    })) {
      expect(batch.events).toEqual([]);
      expect(batch.through).toBeGreaterThan(through);
      expect(s.covers(0, batch.through)).toBe(true);
      const early = events.filter((e) => e.block_number! <= batch.through).map(id);
      const written = new Set(s.events.map(id));
      expect(early.every((e) => written.has(e))).toBe(true);
      through = batch.through;
    }
    expect(through).toBe(19_999);
    expect(s.events.map(id).sort()).toEqual(events.map(id).sort());
    for (const [a, b] of s.ranges) {
      const inside = s.events.filter((e) => e.block_number! >= a && e.block_number! <= b);
      expect(inside.length).toBe(
        events.filter((e) => e.block_number! >= a && e.block_number! <= b).length,
      );
    }
  },
);

test("with a store and ranges, only the ranges are fetched, and the blocks between them pass at once", async () => {
  const events = syntheticEvents(20_000, 3);
  const s = fakeStore();
  const asked: [number, number][] = [];
  const node = fakeNode(events, 2_048);
  const rpc = {
    request(method: string, params: { filter: EventFilter }): Promise<unknown> {
      const f = params.filter;
      asked.push([
        (f.from_block as { block_number: number }).block_number,
        (f.to_block as { block_number: number }).block_number,
      ]);
      return (node.rpc as unknown as { request: typeof rpc.request }).request(method, params);
    },
  };
  const seen: number[] = [];
  for await (const batch of eventStream({
    rpc: rpc as unknown as RpcClient,
    address: "0x1",
    from: 0,
    to: 19_999,
    ranges: [
      [5_000, 9_999],
      [15_000, 15_999],
    ],
    chunkSize: 64,
    concurrency: 4,
    store: s.store,
  }))
    seen.push(batch.through);
  expect(seen[0]).toBe(4_999);
  expect(seen.at(-1)).toBe(19_999);
  for (const [a, b] of asked)
    expect((a >= 5_000 && b <= 9_999) || (a >= 15_000 && b <= 15_999)).toBe(true);
  const inRanges = (b: number) => (b >= 5_000 && b <= 9_999) || (b >= 15_000 && b <= 15_999);
  expect(s.events.map(id).sort()).toEqual(
    events
      .filter((e) => inRanges(e.block_number!))
      .map(id)
      .sort(),
  );
});

test("a slow store slows fetching: what waits to be written stays near its limit", async () => {
  const events = syntheticEvents(20_000, 9);
  const s = fakeStore(500, 20);
  let n = 0;
  for await (const _ of eventStream({
    rpc: fakeNode(events, 2_048).rpc,
    address: "0x1",
    from: 0,
    to: 19_999,
    chunkSize: 64,
    concurrency: 16,
    store: s.store,
  }))
    n++;
  expect(n).toBeGreaterThan(0);
  expect(s.events.length).toBe(events.length);
  // Past the limit, each worker may add the page it was given room for, with the start of a block the page before
  // it held back (at most 40 events here).
  expect(s.peak()).toBeLessThanOrEqual(500 + 16 * (64 + 40));
}, 60_000);

test("with a store, a failed write fails the stream", async () => {
  const store: PageStore = {
    write: () => Promise.reject(new Error("disk full")),
    room: () => Promise.resolve(),
    held: () => ({ bytes: 0, events: 0, max: 1 }),
  };
  const run = async () => {
    for await (const _ of eventStream({
      rpc: fakeNode(syntheticEvents(5_000, 1), 2_048).rpc,
      address: "0x1",
      from: 0,
      to: 4_999,
      chunkSize: 64,
      concurrency: 4,
      store,
    }));
  };
  await expect(run()).rejects.toThrow("disk full");
});

test("with a store, the front keeps up: halfway through the fetch, about half the events can be read", async () => {
  // Sparse, then dense, as Ekubo's history: the first cuts, at a sparse density, halve the whole range.
  const SPARSE = 10_000;
  const BLOCKS = 50_000;
  const events: EmittedEvent[] = [];
  for (let b = 0; b < BLOCKS; b++)
    for (let i = 0; i < (b < SPARSE ? (b % 40 === 0 ? 1 : 0) : 3); i++)
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
    request: (method: string, params: unknown) => Promise<unknown>;
  };
  const rpc = {
    async request(method: string, params: unknown): Promise<unknown> {
      await new Promise((r) => setTimeout(r, 2));
      return inner.request(method, params);
    },
  };
  const s = fakeStore(Number.POSITIVE_INFINITY, 0);
  let throughAtHalf: number | undefined;
  for await (const batch of eventStream({
    rpc: rpc as unknown as RpcClient,
    address: "0x1",
    from: 0,
    to: BLOCKS - 1,
    chunkSize: 64,
    concurrency: 16,
    store: s.store,
  }))
    if (throughAtHalf === undefined && s.events.length >= events.length / 2)
      throughAtHalf = batch.through;
  expect(s.events.length).toBe(events.length);
  // Half the events lie before block 30k: with the work near the front, the front is not far behind.
  expect(throughAtHalf).toBeGreaterThan(22_000);
}, 60_000);

test("workers' time is split into getEvents, waiting for the store's room and idle, over the last seconds", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    const node = fakeNode(syntheticEvents(20_000, 7), 2_048);
    const slow = {
      async request(method: string, params: unknown) {
        await new Promise((r) => setTimeout(r, 200));
        return node.rpc.request(method, params);
      },
    } as unknown as RpcClient;
    let gauges: (() => FetchGauges) | undefined;
    const s = fakeStore();
    const run = (async () => {
      for await (const _ of eventStream({
        rpc: slow,
        address: "0x1",
        from: 0,
        to: 19_999,
        chunkSize: 64,
        concurrency: 2,
        store: s.store,
        gauges: (read) => (gauges = read),
      }));
    })();
    expect(gauges!().workerTime).toEqual({ calls: 0, room: 0, idle: 0 });
    await vi.advanceTimersByTimeAsync(6_000);
    const t = gauges!().workerTime;
    expect(t.calls).toBeGreaterThan(0.9);
    expect(t.room).toBe(0);
    await vi.advanceTimersByTimeAsync(600_000);
    await run;
  } finally {
    vi.useRealTimers();
  }
});
