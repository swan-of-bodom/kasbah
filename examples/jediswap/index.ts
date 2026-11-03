// JediSwap v1 (Cairo 0): every pair the factory created, with swaps, volume and reserves. Factory and pairs are
// proxies, so the ABIs are their implementations'.
//   node --env-file=.env --no-warnings examples/jediswap/index.ts [--to <block>] [--port <n>] [--reset]
//   pnpm kasbah dev examples/jediswap/index.ts
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { kasbah } from "../../src/index.ts";
import factoryAbi from "./factory-abi.ts";
import pairAbi from "./pair-abi.ts";
import * as schema from "./schema.ts";
import { pairs, swaps } from "./schema.ts";

// Run directly it takes flags; imported by the CLI, the defaults. (`import.meta.main` is false for .ts files on Node 24.2.)
const main = resolve(process.argv[1] ?? "") === import.meta.filename;
const { values } = parseArgs({
  args: main ? process.argv.slice(2) : [],
  options: {
    to: { type: "string" },
    port: { type: "string" },
    reset: { type: "boolean" },
  },
});

const FACTORY = "0x00dad44c139a476c7a17fc8141e6db680e9abc9f56fe249a105094c44382c2fd";
const START = 10_765;

const app = kasbah({
  rpc: process.env.KASBAH_RPC_URL!,
  database: process.env.DATABASE_URL!,
  schema: "jediswap",
  contracts: {
    Factory: { abi: factoryAbi, address: FACTORY, startBlock: START },
    Pair: {
      abi: pairAbi,
      factory: { address: FACTORY, abi: factoryAbi, event: "PairCreated", parameter: "pair" },
      startBlock: START,
    },
  },
  tables: schema,
  ...(values.port === undefined ? {} : { api: { port: Number(values.port) } }),
});

const hexOf = (felt: bigint) => `0x${felt.toString(16).padStart(64, "0")}` as const;

app.on("Factory:PairCreated", async ({ event, context }) => {
  await context.db.insert(pairs).values({
    address: hexOf(event.args.pair),
    token0: hexOf(event.args.token0),
    token1: hexOf(event.args.token1),
    createdAt: event.block.number,
    swaps: 0,
    volume0: 0n,
    volume1: 0n,
    reserve0: 0n,
    reserve1: 0n,
  });
});

app.on("Pair:Swap", async ({ event, context }) => {
  const a = event.args;
  await context.db.insert(swaps).values({
    id: `${event.transaction.hash}:${event.index}`,
    pairAddress: event.address,
    block: event.block.number,
    sender: hexOf(a.sender),
    amount0In: a.amount0In,
    amount1In: a.amount1In,
    amount0Out: a.amount0Out,
    amount1Out: a.amount1Out,
  });
  await context.db.update(pairs, { address: event.address }).set((p) => ({
    swaps: p.swaps + 1,
    volume0: p.volume0 + a.amount0In + a.amount0Out,
    volume1: p.volume1 + a.amount1In + a.amount1Out,
  }));
});

app.on("Pair:Sync", async ({ event, context }) => {
  await context.db
    .update(pairs, { address: event.address })
    .set({ reserve0: event.args.reserve0, reserve1: event.args.reserve1 });
});

export default app;

if (main) {
  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort());
  await app.run({
    to: values.to === undefined ? undefined : Number(values.to),
    reset: values.reset,
    signal: stop.signal,
  });
}
