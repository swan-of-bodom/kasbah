import { expect, test } from "vitest";
import type { RpcClient } from "../src/rpc/client.ts";
import type { EmittedEvent, EventFilter } from "../src/rpc/methods.ts";
import { fetchEvents } from "../src/sync/fetch.ts";

/** A Pathfinder-like node: pages of `chunk` events, at most `scanLimit` blocks per call, token `"<block>-<matched skipped>"`. */
function fakeNode(events: EmittedEvent[], scanLimit: number) {
  let calls = 0;
  const byBlock = new Map<number, EmittedEvent[]>();
  for (const e of events) byBlock.set(e.block_number!, [...(byBlock.get(e.block_number!) ?? []), e]);
  const rpc = {
    async request(_method: string, params: { filter: EventFilter & { chunk_size: number; continuation_token?: string } }) {
      calls++;
      await new Promise((r) => setTimeout(r, Math.random() * 2));
      const f = params.filter;
      const from = (f.from_block as { block_number: number }).block_number;
      const to = (f.to_block as { block_number: number }).block_number;
      let block = from;
      let skip = 0;
      if (f.continuation_token !== undefined) [block, skip] = f.continuation_token.split("-").map(Number) as [number, number];
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
      return scanEnd < to ? { events: out, continuation_token: `${scanEnd + 1}-0` } : { events: out };
    },
  };
  return { rpc: rpc as unknown as RpcClient, calls: () => calls };
}

function syntheticEvents(blocks: number, seed: number): EmittedEvent[] {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const out: EmittedEvent[] = [];
  for (let b = 0; b < blocks; b++) {
    // Dense and empty stretches, like a real contract's history.
    const density = b % 5000 < 1500 ? 0 : b % 5000 < 1600 ? 40 : 3;
    const n = Math.floor(rand() * density);
    for (let i = 0; i < n; i++) {
      out.push({ from_address: "0x1", keys: [], data: [], block_number: b, transaction_hash: "0x0", transaction_index: Math.floor(i / 4), event_index: i % 4 });
    }
  }
  return out;
}

test.each([
  { concurrency: 1, windowEvents: 256, maxBuffered: 100_000 },
  { concurrency: 4, windowEvents: 256, maxBuffered: 100_000 },
  { concurrency: 16, windowEvents: 64, maxBuffered: 100_000 },
  { concurrency: 32, windowEvents: 4096, maxBuffered: 100_000 },
  { concurrency: 16, windowEvents: 256, maxBuffered: 500 },
])("every event exactly once, in order: %o", async ({ concurrency, windowEvents, maxBuffered }) => {
  const events = syntheticEvents(20_000, concurrency);
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
    maxBuffered,
    onEvents(page) {
      for (const e of page) seen.push(`${e.block_number}:${e.transaction_index}:${e.event_index}`);
    },
  });
  expect(stats.events).toBe(events.length);
  expect(new Set(seen).size).toBe(events.length);
  expect(seen).toEqual(events.map((e) => `${e.block_number}:${e.transaction_index}:${e.event_index}`));
  // Three budgets (see `mayFetch`), plus one page from each request in flight.
  expect(stats.peakBuffered).toBeLessThanOrEqual(3 * maxBuffered + concurrency * 64);
  if (concurrency > 1) expect(stats.splits).toBeGreaterThan(0);
});
