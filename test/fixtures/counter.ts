import { createServer } from "node:http";
import { selector } from "../../src/abi/selector.ts";

/** A contract emitting `Counted { amount: n + 1 }` in every block `n` of a chain of `blocks` blocks. */
export const counterAbi = [
  { type: "event", name: "c::Counted", kind: "struct", members: [{ name: "amount", type: "core::integer::u128", kind: "data" }] },
  { type: "event", name: "c::Event", kind: "enum", variants: [{ name: "Counted", type: "c::Counted", kind: "nested" }] },
];

/** A node serving that chain, the contract at any address. Listen on it, then point `rpc` at it. */
export function counterNode(blocks: number) {
  const abi = counterAbi;
  const BLOCKS = blocks;
  const hash = (n: number) => `0x${(n + 1).toString(16)}aa`;
  const events = Array.from({ length: BLOCKS }, (_, n) => ({
    from_address: "0xc", keys: [selector("Counted")], data: [`0x${(n + 1).toString(16)}`], block_number: n, block_hash: hash(n), transaction_hash: `0x${n}`, transaction_index: 0, event_index: 0,
  }));

  return createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const answer = ({ id, method, params }: { id: number; method: string; params: any }) => {
        const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
        switch (method) {
          case "starknet_specVersion": return ok("0.10.4");
          case "pathfinder_version": return ok("fake");
          case "starknet_blockNumber": return ok(BLOCKS - 1);
          case "starknet_blockHashAndNumber": return ok({ block_hash: hash(BLOCKS - 1), block_number: BLOCKS - 1 });
          case "starknet_getBlockWithTxHashes": {
            const n = params.block_id.block_number;
            if (n >= BLOCKS) return { jsonrpc: "2.0", id, error: { code: 24, message: "Block not found" } };
            return ok({ block_hash: hash(n), parent_hash: n === 0 ? "0x0" : hash(n - 1), block_number: n, timestamp: 1_000 + n, status: "ACCEPTED_ON_L2", transactions: [] });
          }
          case "starknet_getClassHashAt": return ok("0xca");
          case "starknet_getClass": return ok({ abi: JSON.stringify(abi) });
          case "starknet_getEvents": {
            const f = params.filter;
            return ok({ events: events.filter((e) => e.block_number >= f.from_block.block_number && e.block_number <= f.to_block.block_number) });
          }
        }
        return { jsonrpc: "2.0", id, error: { code: -32601, message: method } };
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(answer) : answer(parsed)));
    });
  });
}
