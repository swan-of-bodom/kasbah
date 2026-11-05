import { expect, test, vi } from "vitest";
import type { RpcClient } from "../../src/rpc/client.ts";
import type { EmittedEvent, EventFilter } from "../../src/rpc/methods.ts";
import {
  eventStream,
  type FetchGauges,
  type FetchStats,
  type PageStore,
} from "../../src/sync/fetch.ts";

/**
 * A Pathfinder-like node: pages of `chunk` events, at most `scanLimit` blocks per call, token `"<block>-<matched
 * skipped>"`. Behind a gateway that cuts off a call scanning more than `gatewayBlocks` blocks, as the free RPC did
 * with Juno (no scan limit of its own): the call fails as a timeout.
 */
function fakeNode(
  events: EmittedEvent[],
  scanLimit: number,
  gatewayBlocks = Number.POSITIVE_INFINITY,
) {
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
        if (b - block >= gatewayBlocks) {
          const timeout = new Error("The operation was aborted due to timeout");
          timeout.name = "TimeoutError";
          throw timeout;
        }
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

const id = (e: EmittedEvent) => `${e.block_number}:${e.transaction_index}:${e.event_index}`;

test.each([1, 2, 5])(
  "with at most %i windows, every event is still written once",
  async (maxWindows) => {
    const events = syntheticEvents(20_000, maxWindows);
    const s = fakeStore();
    let read: (() => FetchGauges) | undefined;
    let peak = 0;
    const stats: FetchStats = { events: 0, pages: 0, windows: 0, splits: 0, narrowed: 0 };
    const stream = eventStream(
      {
        rpc: fakeNode(events, 2_048).rpc,
        address: "0x1",
        from: 0,
        to: 19_999,
        chunkSize: 16,
        concurrency: 8,
        windowEvents: 1,
        minSplit: 1,
        maxWindows,
        store: s.store,
        gauges: (r) => (read = r),
      },
      stats,
    );
    for await (const _ of stream) peak = Math.max(peak, read!().windows);
    expect(peak).toBeLessThanOrEqual(maxWindows);
    expect(stats.events).toBe(events.length);
    expect(s.events.map(id).sort()).toEqual(events.map(id).sort());
    if (maxWindows > 1) expect(stats.splits).toBeGreaterThan(0);
    expect(stats.narrowed).toBe(0);
  },
);

test.each([1, 4])(
  "a node that can't scan a sparse range in time gets narrower requests, and every event is written once: %i workers",
  async (concurrency) => {
    // Like JediSwap's factory: dense at first, then a dozen events over a million blocks.
    const event = (block: number, i: number): EmittedEvent => ({
      from_address: "0x1",
      keys: [],
      data: [],
      block_number: block,
      transaction_hash: "0x0",
      transaction_index: i,
      event_index: 0,
    });
    const events = [
      ...Array.from({ length: 2_000 }, (_, i) => event(Math.floor(i / 2), i % 2)),
      ...Array.from({ length: 12 }, (_, i) => event(2_000 + i * 83_000, 0)),
    ];
    const s = fakeStore();
    const stats: FetchStats = { events: 0, pages: 0, windows: 0, splits: 0, narrowed: 0 };
    let through = -1;
    for await (const batch of eventStream(
      {
        rpc: fakeNode(events, Number.POSITIVE_INFINITY, 50_000).rpc,
        address: "0x1",
        from: 0,
        to: 999_999,
        chunkSize: 64,
        concurrency,
        store: s.store,
      },
      stats,
    ))
      through = batch.through;
    expect(through).toBe(999_999);
    expect(stats.narrowed).toBeGreaterThan(0);
    expect(stats.events).toBe(events.length);
    expect(s.events.map(id).sort()).toEqual(events.map(id).sort());
  },
);

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
    expect(gauges!().workerTime).toBeUndefined();
    await vi.advanceTimersByTimeAsync(6_000);
    const t = gauges!().workerTime!;
    expect(t.calls).toBeGreaterThan(0.9);
    expect(t.room).toBe(0);
    await vi.advanceTimersByTimeAsync(600_000);
    await run;
  } finally {
    vi.useRealTimers();
  }
});
