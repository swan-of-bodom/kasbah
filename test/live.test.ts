import { expect, test } from "vitest";
import { RpcError, type RpcClient } from "../src/rpc/client.ts";
import type { EmittedEvent } from "../src/rpc/methods.ts";
import { type BlockRef, follow } from "../src/sync/live.ts";
import { header } from "./fixtures/header.ts";

type Block = { number: number; hash: string; parent: string; events: EmittedEvent[] };

/** A chain that grows, can fork, and sometimes answers like a load-balanced node that is behind. */
function fakeChain(seed: number) {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  let fork = 0;
  const blocks: Block[] = [];
  const add = () => {
    const number = blocks.length;
    const parent = blocks.at(-1)?.hash ?? "0x0";
    const hash = `0x${number.toString(16)}f${fork}`;
    const events = Array.from({ length: Math.floor(rand() * 3) }, (_, i): EmittedEvent => ({
      from_address: "0x1", keys: [], data: [hash], block_number: number, block_hash: hash, transaction_hash: "0x0", transaction_index: 0, event_index: i,
    }));
    blocks.push({ number, hash, parent, events });
  };
  for (let i = 0; i <= 10; i++) add();
  /** Replaces the last `depth` blocks with new ones. */
  const reorg = (depth: number) => {
    fork++;
    blocks.splice(blocks.length - depth, depth);
    for (let i = 0; i < depth; i++) add();
  };
  let stale: Block[] | undefined;
  const view = () => stale ?? blocks;
  const rpc = {
    async request(method: string, params: any) {
      await new Promise((r) => setTimeout(r, 0));
      if (method === "starknet_blockHashAndNumber") {
        // Sometimes a node behind: an older tip, then (below) the same node's view for the rest of the tick.
        stale = rand() < 0.15 ? blocks.slice(0, Math.max(1, blocks.length - 3)) : undefined;
        const tip = view().at(-1)!;
        return { block_hash: tip.hash, block_number: tip.number };
      }
      if (method === "starknet_getEvents") {
        const f = params.filter;
        return { events: view().filter((b) => b.number >= f.from_block.block_number && b.number <= f.to_block.block_number).flatMap((b) => b.events) };
      }
      throw new Error(method);
    },
    async batch(calls: { method: string; params: any }[]) {
      return calls.map(({ params }) => {
        const b = (rand() < 0.1 ? blocks.slice(0, -1) : view())[params.block_id.block_number];
        if (b === undefined) throw new RpcError("starknet_getBlockWithTxHashes", 24, "Block not found");
        return header({ block_hash: b.hash, parent_hash: b.parent, block_number: b.number, timestamp: 0 });
      });
    },
  };
  return { rpc: rpc as unknown as RpcClient, blocks, add, reorg };
}

test.each([1, 2, 3, 4, 5])("follows growth and reorgs to the canonical chain (seed %i)", async (seed) => {
  const chain = fakeChain(seed);
  const applied: Block[] = chain.blocks.slice(0, 11).map((b) => ({ ...b }));
  const known = new Map(applied.map((b) => [b.number, b.hash]));
  const head: BlockRef = { number: 10, hash: chain.blocks[10]!.hash };
  const stop = new AbortController();
  let reorgs = 0;

  const run = follow({
    rpc: chain.rpc, address: "0x1", chunkSize: 100, head, known, pollMs: 1, signal: stop.signal,
    onBlock: async (b) => {
      expect(b.number).toBe(applied.length);
      expect(b.parent).toBe(applied.at(-1)!.hash);
      expect(b.events.every((e) => e.block_hash === b.hash)).toBe(true);
      applied.push({ number: b.number, hash: b.hash, parent: b.parent, events: b.events });
      known.set(b.number, b.hash);
    },
    onReorg: async (a) => {
      reorgs++;
      expect(applied[a.number]!.hash).toBe(a.hash);
      applied.splice(a.number + 1);
      for (const n of known.keys()) if (n > a.number) known.delete(n);
    },
  });

  for (let step = 0; step < 60; step++) {
    if (step % 7 === 6) chain.reorg(1 + (step % 4));
    else chain.add();
    await new Promise((r) => setTimeout(r, 3));
  }
  // A reorg of the head block itself, at the same height.
  chain.reorg(1);
  const deadline = Date.now() + 5_000;
  while (applied.at(-1)!.hash !== chain.blocks.at(-1)!.hash && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  stop.abort();
  await run;

  expect(applied.map((b) => b.hash)).toEqual(chain.blocks.map((b) => b.hash));
  expect(applied.flatMap((b) => b.events)).toEqual(chain.blocks.flatMap((b) => b.events));
  expect(reorgs).toBeGreaterThan(0);
});

test("a reorg deeper than the known blocks is an error", async () => {
  const chain = fakeChain(9);
  const known = new Map([[10, chain.blocks[10]!.hash]]);
  chain.reorg(5);
  chain.add();
  await expect(
    follow({
      rpc: chain.rpc, address: "0x1", chunkSize: 100, head: { number: 10, hash: known.get(10)! }, known, pollMs: 1,
      signal: new AbortController().signal, onBlock: async () => {}, onReorg: async () => {},
    }),
  ).rejects.toThrow(/reorg deeper/);
});
