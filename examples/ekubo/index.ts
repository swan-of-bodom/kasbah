// Ekubo pools: one row per pool with swap count, volume and the latest price, tick and liquidity.
//   node --env-file=.env --no-warnings examples/ekubo/index.ts [--start <block>] [--to <block>] [--port <n>] [--cache] [--ws] [--reset]
// Without --to it backfills, then follows the head until Ctrl-C.
import { parseArgs } from "node:util";
import { createConfig, kasbah } from "../../src/index.ts";
import abi from "./abi.ts";
import { pools } from "./schema.ts";

const { values } = parseArgs({
  options: { start: { type: "string" }, to: { type: "string" }, port: { type: "string" }, cache: { type: "boolean" }, ws: { type: "boolean" }, reset: { type: "boolean" } },
});

const config = createConfig({
  rpc: process.env.KASBAH_RPC_URL!,
  database: process.env.DATABASE_URL!,
  schema: "ekubo",
  contracts: {
    Core: { abi, address: "0x00000005dd3d2f4429af886cd1a3b08289dbcea99a294197e9eb43b0e0325b4b", startBlock: values.start === undefined ? 165_392 : Number(values.start) },
  },
  tables: { pools },
  ...(values.port === undefined ? {} : { api: { port: Number(values.port) } }),
  cache: values.cache ?? false,
  ...(values.ws ? { ws: true as const } : {}),
});

const app = kasbah(config);

type PoolKey = { token0: `0x${string}`; token1: `0x${string}`; fee: bigint; tick_spacing: bigint; extension: `0x${string}` };
const poolId = (k: PoolKey) => `${k.token0}:${k.token1}:${k.fee}:${k.tick_spacing}:${k.extension}`;
const signed = (v: { mag: bigint; sign: boolean }) => (v.sign ? -v.mag : v.mag);
const abs = (v: { mag: bigint }) => v.mag;

app.on("Core:PoolInitialized", async ({ event, context }) => {
  const k = event.args.pool_key;
  await context.db.insert(pools).values({
    id: poolId(k),
    token0: k.token0,
    token1: k.token1,
    fee: k.fee,
    tickSpacing: k.tick_spacing,
    extension: k.extension,
    createdAt: event.block.number,
    swaps: 0,
    volume0: 0n,
    volume1: 0n,
    // Before block 629,533 Ekubo's PoolInitialized had no sqrt_ratio.
    sqrtRatio: event.args.sqrt_ratio ?? null,
    tick: signed(event.args.initial_tick),
    liquidity: 0n,
  });
});

app.on("Core:Swapped", async ({ event, context }) => {
  const { pool_key, delta, sqrt_ratio_after, tick_after, liquidity_after } = event.args;
  const id = poolId(pool_key);
  // Started with --start after the pool was created: it isn't indexed.
  if (values.start !== undefined && (await context.db.find(pools, { id })) === null) return;
  await context.db.update(pools, { id }).set((p) => ({
    swaps: p.swaps + 1,
    volume0: p.volume0 + abs(delta.amount0),
    volume1: p.volume1 + abs(delta.amount1),
    sqrtRatio: sqrt_ratio_after,
    tick: signed(tick_after),
    liquidity: liquidity_after,
  }));
});

const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
await app.run({ to: values.to === undefined ? undefined : Number(values.to), reset: values.reset, signal: stop.signal });
