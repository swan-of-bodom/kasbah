// Ekubo pools: per pool its price, liquidity and balances; hourly and daily candles (price, volume, fees, TVL);
// protocol totals every 1,800 blocks; and an API over them (/pools/top, /pools/:id/candles, /history).
//   node --env-file=.env --no-warnings examples/ekubo/index.ts [--start <block>] [--to <block>] [--port <n>] [--cache] [--ws] [--include] [--reset]
//   pnpm kasbah dev examples/ekubo/index.ts       (the defaults, restarted on every change)
// Without --to it backfills, then follows the head until Ctrl-C.
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { kasbah, createConfig, type Db, HttpError } from "../../src/index.ts";
import abi from "./abi.ts";
import { candles, history, pools, totals } from "./schema.ts";

// Run directly it takes flags; imported by the CLI, the defaults. (`import.meta.main` is false for .ts files on Node 24.2.)
const main = resolve(process.argv[1] ?? "") === import.meta.filename;
const { values } = parseArgs({
  args: main ? process.argv.slice(2) : [],
  options: { start: { type: "string" }, to: { type: "string" }, port: { type: "string" }, cache: { type: "boolean" }, ws: { type: "boolean" }, include: { type: "boolean" }, reset: { type: "boolean" } },
});
const startBlock = values.start === undefined ? 165_392 : Number(values.start);

const config = createConfig({
  rpc: process.env.KASBAH_RPC_URL!,
  database: process.env.DATABASE_URL!,
  schema: "ekubo",
  contracts: {
    Core: {
      abi,
      address: "0x00000005dd3d2f4429af886cd1a3b08289dbcea99a294197e9eb43b0e0325b4b",
      startBlock,
      include: values.include ? { block: true, transaction: true, receipt: true } : { block: true },
    },
  },
  blocks: { Snapshot: { interval: 1_800, startBlock } },
  tables: { pools, candles, totals, history },
  api: { port: Number(values.port ?? 42069) },
  cache: values.cache ?? false,
  ...(values.ws ? { ws: true as const } : {}),
});

const app = kasbah(config);

type PoolKey = { token0: `0x${string}`; token1: `0x${string}`; fee: bigint; tick_spacing: bigint; extension: `0x${string}` };
type I129 = { mag: bigint; sign: boolean };
const poolId = (k: PoolKey) => `${k.token0}:${k.token1}:${k.fee}:${k.tick_spacing}:${k.extension}`;
const signed = (v: I129) => (v.sign ? -v.mag : v.mag);
const Q128 = 2 ** 128;
/** token1 per token0, raw units. Before block 629,533 PoolInitialized had no sqrt_ratio: the tick (base 1.000001) then. */
const priceOf = (p: { sqrtRatio: bigint | null; tick: bigint }) => (p.sqrtRatio === null ? 1.000001 ** Number(p.tick) : (Number(p.sqrtRatio) / Q128) ** 2);
const INTERVALS = [3_600, 86_400];

const totalsRow = { id: "all", pools: 0, swaps: 0, positionUpdates: 0 };
async function count(db: Db, field: "pools" | "swaps" | "positionUpdates") {
  await db.insert(totals).values({ ...totalsRow, [field]: 1 }).onConflictDoUpdate((t) => ({ [field]: t[field] + 1 }));
}

type Swap = { volume0: bigint; volume1: bigint; fees0: bigint; fees1: bigint };
/** Adds to the pool's candles at `timestamp`: a swap moves the price, anything else only the balances. */
async function candle(db: Db, pool: typeof pools.$inferSelect, timestamp: number, swap?: Swap) {
  const price = priceOf(pool);
  for (const interval of INTERVALS) {
    const time = timestamp - (timestamp % interval);
    const add = swap ?? { volume0: 0n, volume1: 0n, fees0: 0n, fees1: 0n };
    await db
      .insert(candles)
      .values({ pool: pool.id, interval, time, open: price, high: price, low: price, close: price, swaps: swap ? 1 : 0, ...add, balance0: pool.balance0, balance1: pool.balance1 })
      .onConflictDoUpdate((c) => ({
        ...(swap ? { high: Math.max(c.high, price), low: Math.min(c.low, price), close: price, swaps: c.swaps + 1 } : {}),
        volume0: c.volume0 + add.volume0,
        volume1: c.volume1 + add.volume1,
        fees0: c.fees0 + add.fees0,
        fees1: c.fees1 + add.fees1,
        balance0: pool.balance0,
        balance1: pool.balance1,
      }));
  }
}

/** Applies `delta` (positive: paid into the pool) and the changes in `set`, then records the candle. */
async function move(db: Db, key: PoolKey, timestamp: number, delta: { amount0: I129; amount1: I129 }, set: Partial<typeof pools.$inferSelect> = {}, swap?: Swap) {
  const id = poolId(key);
  const p = await db.find(pools, { id });
  // Started with --start after the pool was created: it isn't indexed.
  if (p === null) return;
  const next = { ...p, ...set, balance0: p.balance0 + signed(delta.amount0), balance1: p.balance1 + signed(delta.amount1) };
  await db.update(pools, { id }).set({ ...set, balance0: next.balance0, balance1: next.balance1 });
  await candle(db, next, timestamp, swap);
}

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
    sqrtRatio: event.args.sqrt_ratio ?? null,
    tick: signed(event.args.initial_tick),
    liquidity: 0n,
    balance0: 0n,
    balance1: 0n,
  });
  await count(context.db, "pools");
});

app.on("Core:Swapped", async ({ event, context }) => {
  const { pool_key, delta, sqrt_ratio_after, tick_after, liquidity_after } = event.args;
  const p = await context.db.find(pools, { id: poolId(pool_key) });
  if (p === null) return;
  // The fee is charged on the input, the side paid in: amount × fee / 2^128.
  const fee = (a: I129) => (a.sign ? 0n : (a.mag * pool_key.fee) >> 128n);
  const swap = { volume0: delta.amount0.mag, volume1: delta.amount1.mag, fees0: fee(delta.amount0), fees1: fee(delta.amount1) };
  const set = { swaps: p.swaps + 1, volume0: p.volume0 + swap.volume0, volume1: p.volume1 + swap.volume1, sqrtRatio: sqrt_ratio_after, tick: signed(tick_after), liquidity: liquidity_after };
  await move(context.db, pool_key, event.block.timestamp, delta, set, swap);
  await count(context.db, "swaps");
});

// Withdrawals pay out less Ekubo's protocol fee, which stays in Core: the balance overstates the pool by that much.
app.on("Core:PositionUpdated", async ({ event, context }) => {
  await move(context.db, event.args.pool_key, event.block.timestamp, event.args.delta);
  await count(context.db, "positionUpdates");
});

app.on("Core:PositionFeesCollected", async ({ event, context }) => {
  await move(context.db, event.args.pool_key, event.block.timestamp, event.args.delta);
});

app.on("Core:FeesAccumulated", async ({ event, context }) => {
  const { amount0, amount1 } = event.args;
  await move(context.db, event.args.pool_key, event.block.timestamp, { amount0: { mag: amount0, sign: false }, amount1: { mag: amount1, sign: false } });
});

app.on("Snapshot:block", async ({ event, context }) => {
  const t = (await context.db.find(totals, { id: "all" })) ?? totalsRow;
  await context.db.insert(history).values({ block: event.block.number, timestamp: event.block.timestamp, pools: t.pools, swaps: t.swaps, positionUpdates: t.positionUpdates });
});

/** The most swapped pools in the day after `?since=` (unix seconds; default: the last day), with their latest state. */
app.get("/pools/top", async ({ db, query }) => {
  const limit = Math.min(Number(query.get("limit") ?? 20) || 20, 100);
  const since = Number(query.get("since") ?? Math.floor(Date.now() / 1000) - 86_400);
  if (!Number.isInteger(since)) throw new HttpError(400, "since is unix seconds");
  const swaps24h = sql<number>`sum(${candles.swaps})::int`;
  return db
    .select({ pool: pools, swaps24h })
    .from(candles)
    .innerJoin(pools, eq(pools.id, candles.pool))
    .where(and(eq(candles.interval, 3_600), gte(candles.time, since), lt(candles.time, since + 86_400)))
    .groupBy(pools.id)
    .orderBy(desc(swaps24h))
    .limit(limit);
});

/** `?interval=3600|86400&limit=n`: the newest `n` candles, oldest first. */
app.get("/pools/:id/candles", async ({ db, params, query }) => {
  const interval = Number(query.get("interval") ?? 3_600);
  if (!INTERVALS.includes(interval)) throw new HttpError(400, `interval is one of ${INTERVALS.join(", ")}`);
  const limit = Math.min(Number(query.get("limit") ?? 200) || 200, 1_000);
  const rows = await db.select().from(candles).where(and(eq(candles.pool, params.id!), eq(candles.interval, interval))).orderBy(desc(candles.time)).limit(limit);
  if (rows.length === 0 && (await db.select({ id: pools.id }).from(pools).where(eq(pools.id, params.id!))).length === 0) throw new HttpError(404, `no pool ${params.id}`);
  return rows.reverse();
});

app.get("/history", async ({ db, query }) => db.select().from(history).orderBy(desc(history.block)).limit(Math.min(Number(query.get("limit") ?? 100) || 100, 1_000)));

export default app;

if (main) {
  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort());
  await app.run({ to: values.to === undefined ? undefined : Number(values.to), reset: values.reset, signal: stop.signal });
}
