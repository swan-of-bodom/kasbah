import app from "../kasbah.config.ts";
import { pool, swap } from "../kasbah.schema.ts";

type PoolKey = {
  token0: string;
  token1: string;
  fee: bigint;
  tick_spacing: bigint;
  extension: string;
};
/** Ekubo's signed integer: a magnitude and a sign (true: negative). */
type I129 = { mag: bigint; sign: boolean };

const poolId = (k: PoolKey) => `${k.token0}:${k.token1}:${k.fee}:${k.tick_spacing}:${k.extension}`;
const signed = (v: I129) => (v.sign ? -v.mag : v.mag);

app.on("Core:PoolInitialized", async ({ event, context }) => {
  const k = event.args.pool_key;
  await context.db.insert(pool).values({
    id: poolId(k),
    token0: k.token0,
    token1: k.token1,
    fee: k.fee,
    tickSpacing: k.tick_spacing,
    extension: k.extension,
    createdAt: event.block.number,
    swapCount: 0,
    sqrtRatio: event.args.sqrt_ratio ?? null,
    tick: signed(event.args.initial_tick),
    liquidity: 0n,
  });
});

app.on("Core:Swapped", async ({ event, context }) => {
  const { pool_key, locker, delta, sqrt_ratio_after, tick_after, liquidity_after } = event.args;
  const id = poolId(pool_key);
  await context.db.insert(swap).values({
    id: `${event.transaction.hash}:${event.index}`,
    poolId: id,
    block: event.block.number,
    locker,
    amount0: signed(delta.amount0),
    amount1: signed(delta.amount1),
    sqrtRatioAfter: sqrt_ratio_after,
    tickAfter: signed(tick_after),
    liquidityAfter: liquidity_after,
  });
  await context.db.update(pool, { id }).set((p) => ({
    swapCount: p.swapCount + 1,
    sqrtRatio: sqrt_ratio_after,
    tick: signed(tick_after),
    liquidity: liquidity_after,
  }));
});
