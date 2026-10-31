import { createServer } from "node:http";
import { selector } from "../../src/abi/selector.ts";
import { header } from "./header.ts";

/** A contract emitting `Counted { amount: n + 1 }` in every block `n` of a chain of `blocks` blocks. */
export const counterAbi = [
  {
    type: "event",
    name: "c::Counted",
    kind: "struct",
    members: [{ name: "amount", type: "core::integer::u128", kind: "data" }],
  },
  {
    type: "event",
    name: "c::Event",
    kind: "enum",
    variants: [{ name: "Counted", type: "c::Counted", kind: "nested" }],
  },
] as const;

/**
 * A node serving that chain, the contract at any address from block `deployed`; block n's event comes from
 * `addresses[n % length]`; L1 accepted blocks through `l1`. Listen on it, then point `rpc` at it.
 */
export function counterNode(
  blocks: number,
  {
    deployed = 0,
    addresses = ["0xc"],
    l1 = 0,
  }: { deployed?: number; addresses?: string[]; l1?: number } = {},
) {
  const abi = counterAbi;
  const BLOCKS = blocks;
  const hash = (n: number) => `0x${(n + 1).toString(16)}aa`;
  const events = Array.from({ length: BLOCKS }, (_, n) => ({
    from_address: addresses[n % addresses.length]!,
    keys: [selector("Counted")],
    data: [`0x${(n + 1).toString(16)}`],
    block_number: n,
    block_hash: hash(n),
    transaction_hash: `0x${n}`,
    transaction_index: 0,
    event_index: 0,
  }));

  return createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const answer = ({ id, method, params }: { id: number; method: string; params: any }) => {
        const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
        switch (method) {
          case "starknet_specVersion":
            return ok("0.10.4");
          case "starknet_chainId":
            return ok("0xc0c0");
          case "pathfinder_version":
            return ok("fake");
          case "starknet_blockNumber":
            return ok(BLOCKS - 1);
          case "starknet_blockHashAndNumber":
            return ok({ block_hash: hash(BLOCKS - 1), block_number: BLOCKS - 1 });
          case "starknet_getBlockWithTxHashes": {
            const n = params.block_id === "l1_accepted" ? l1 : params.block_id.block_number;
            if (n >= BLOCKS)
              return { jsonrpc: "2.0", id, error: { code: 24, message: "Block not found" } };
            return ok(
              header({
                block_hash: hash(n),
                parent_hash: n === 0 ? "0x0" : hash(n - 1),
                block_number: n,
                timestamp: 1_000 + n,
              }),
            );
          }
          case "starknet_getClassHashAt":
            if (params.block_id.block_number < deployed)
              return { jsonrpc: "2.0", id, error: { code: 20, message: "Contract not found" } };
            return ok("0xca");
          case "starknet_getClass":
            return ok({ abi: JSON.stringify(abi) });
          case "starknet_getEvents": {
            const f = params.filter;
            const from = f.address === undefined ? undefined : [f.address].flat().map(BigInt);
            const matched = events.filter(
              (e) =>
                e.block_number >= f.from_block.block_number &&
                e.block_number <= f.to_block.block_number &&
                (from === undefined || from.includes(BigInt(e.from_address))),
            );
            // Pages of `chunk_size` with Pathfinder's `<block>-<index in block>` token, as kasbah reads it.
            let at = 0;
            if (f.continuation_token !== undefined) {
              const [block, index] = f.continuation_token.split("-").map(Number);
              while (at < matched.length && matched[at]!.block_number < block) at++;
              at += index;
            }
            const end = Math.min(matched.length, at + (f.chunk_size ?? matched.length));
            const next = matched[end];
            const token =
              next === undefined
                ? undefined
                : `${next.block_number}-${end - matched.findIndex((e) => e.block_number === next.block_number)}`;
            return ok({
              events: matched.slice(at, end),
              ...(token === undefined ? {} : { continuation_token: token }),
            });
          }
        }
        return { jsonrpc: "2.0", id, error: { code: -32601, message: method } };
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(answer) : answer(parsed)));
    });
  });
}
