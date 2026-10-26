import { createServer } from "node:http";
import { selector } from "../../src/abi/selector.ts";
import { header } from "./header.ts";

/** `Moved { #[key] who, amount }` and `Pinged { n }`: who is 0x1, 0x2, 0x3 in turn. */
export const keyedAbi = [
  {
    type: "event",
    name: "k::Moved",
    kind: "struct",
    members: [
      { name: "who", type: "core::starknet::contract_address::ContractAddress", kind: "key" },
      { name: "amount", type: "core::integer::u128", kind: "data" },
    ],
  },
  {
    type: "event",
    name: "k::Pinged",
    kind: "struct",
    members: [{ name: "n", type: "core::integer::u32", kind: "data" }],
  },
  {
    type: "event",
    name: "k::Event",
    kind: "enum",
    variants: [
      { name: "Moved", type: "k::Moved", kind: "nested" },
      { name: "Pinged", type: "k::Pinged", kind: "nested" },
    ],
  },
] as const;

/** A node with, in every block, a `Moved` then a `Pinged`; `getEvents` honors positional keys and is recorded. */
export function keyedNode(blocks: number) {
  const hash = (n: number) => `0x${(n + 1).toString(16)}bb`;
  const event = (n: number, i: number, keys: string[], data: string[]) => ({
    from_address: "0xd",
    keys,
    data,
    block_number: n,
    block_hash: hash(n),
    transaction_hash: `0x${n}`,
    transaction_index: 0,
    event_index: i,
  });
  const events = Array.from({ length: blocks }, (_, n) => [
    event(n, 0, [selector("Moved"), `0x${(n % 3) + 1}`], [`0x${(n + 1).toString(16)}`]),
    event(n, 1, [selector("Pinged")], [`0x${n.toString(16)}`]),
  ]).flat();
  const filters: { keys?: string[][] }[] = [];
  const matches = (keys: string[], filter: string[][] | undefined) =>
    filter === undefined ||
    filter.every(
      (allowed, i) =>
        allowed.length === 0 || allowed.some((k) => BigInt(k) === BigInt(keys[i] ?? -1)),
    );

  const server = createServer((req, res) => {
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
            return ok(blocks - 1);
          case "starknet_getBlockWithTxHashes": {
            const n = params.block_id.block_number;
            if (n >= blocks)
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
            return ok("0xca");
          case "starknet_getClass":
            return ok({ abi: JSON.stringify(keyedAbi) });
          case "starknet_getEvents": {
            const f = params.filter;
            filters.push({ keys: f.keys });
            return ok({
              events: events.filter(
                (e) =>
                  e.block_number >= f.from_block.block_number &&
                  e.block_number <= f.to_block.block_number &&
                  matches(e.keys, f.keys),
              ),
            });
          }
        }
        return { jsonrpc: "2.0", id, error: { code: -32601, message: method } };
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(answer) : answer(parsed)));
    });
  });
  return { server, filters };
}
