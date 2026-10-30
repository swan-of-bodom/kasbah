import type { Db } from "../../../src/index.ts";
import app from "../kasbah.config.ts";
import { candles, history, pools, totals } from "../kasbah.schema.ts";

type PoolKey = {
  token0: `0x${string}`;
  token1: `0x${string}`;
  fee: bigint;
  tick_spacing: bigint;
  extension: `0x${string}`;
};
type I129 = { mag: bigint; sign: boolean };
const poolId = (k: PoolKey) => `${k.token0}:${k.token1}:${k.fee}:${k.tick_spacing}:${k.extension}`;
const signed = (v: I129) => (v.sign ? -v.mag : v.mag);
const Q128 = 2 ** 128;
/** token1 per token0, raw units. Before block 629,533 PoolInitialized had no sqrt_ratio: the tick (base 1.000001) then. */
const priceOf = (p: { sqrtRatio: bigint | null; tick: bigint }) =>
  p.sqrtRatio === null ? 1.000001 ** Number(p.tick) : (Number(p.sqrtRatio) / Q128) ** 2;
export const INTERVALS = [3_600, 86_400];

const totalsRow = { id: "all", pools: 0, swaps: 0, positionUpdates: 0 };
async function count(db: Db, field: "pools" | "swaps" | "positionUpdates") {
  await db
    .insert(totals)
    .values({ ...totalsRow, [field]: 1 })
    .onConflictDoUpdate((t) => ({ [field]: t[field] + 1 }));
}

type Swap = { volume0: bigint; volume1: bigint; fees0: bigint; fees1: bigint };
async function candle(db: Db, pool: typeof pools.$inferSelect, timestamp: number, swap?: Swap) {
  const price = priceOf(pool);
  for (const interval of INTERVALS) {
    const time = timestamp - (timestamp % interval);
    const add = swap ?? { volume0: 0n, volume1: 0n, fees0: 0n, fees1: 0n };
    await db
      .insert(candles)
      .values({
        pool: pool.id,
        interval,
        time,
        open: price,
        high: price,
        low: price,
        close: price,
        swaps: swap ? 1 : 0,
        ...add,
        balance0: pool.balance0,
        balance1: pool.balance1,
      })
      .onConflictDoUpdate((c) => ({
        ...(swap
          ? {
              high: Math.max(c.high, price),
              low: Math.min(c.low, price),
              close: price,
              swaps: c.swaps + 1,
            }
          : {}),
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
async function move(
  db: Db,
  key: PoolKey,
  timestamp: number,
  delta: { amount0: I129; amount1: I129 },
  set: Partial<typeof pools.$inferSelect> = {},
  swap?: Swap,
) {
  const id = poolId(key);
  const p = await db.find(pools, { id });
  // A pool created before the start block isn't indexed.
  if (p === null) return;
  const next = {
    ...p,
    ...set,
    balance0: p.balance0 + signed(delta.amount0),
    balance1: p.balance1 + signed(delta.amount1),
  };
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
  const swap = {
    volume0: delta.amount0.mag,
    volume1: delta.amount1.mag,
    fees0: fee(delta.amount0),
    fees1: fee(delta.amount1),
  };
  const set = {
    swaps: p.swaps + 1,
    volume0: p.volume0 + swap.volume0,
    volume1: p.volume1 + swap.volume1,
    sqrtRatio: sqrt_ratio_after,
    tick: signed(tick_after),
    liquidity: liquidity_after,
  };
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
  await move(context.db, event.args.pool_key, event.block.timestamp, {
    amount0: { mag: amount0, sign: false },
    amount1: { mag: amount1, sign: false },
  });
});

app.on("Snapshot:block", async ({ event, context }) => {
  const t = (await context.db.find(totals, { id: "all" })) ?? totalsRow;
  await context.db.insert(history).values({
    block: event.block.number,
    timestamp: event.block.timestamp,
    pools: t.pools,
    swaps: t.swaps,
    positionUpdates: t.positionUpdates,
  });
});
