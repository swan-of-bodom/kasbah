import { bignum, hex, index, integer, pgTable, relations, text } from "kasbah";

/** A pool, keyed by its pool key (`token0:token1:fee:tick_spacing:extension`), as of its last swap. */
export const pool = pgTable("pool", {
  id: text().primaryKey(),
  token0: hex().notNull(),
  token1: hex().notNull(),
  fee: bignum().notNull(),
  tickSpacing: bignum().notNull(),
  extension: hex().notNull(),
  createdAt: integer().notNull(),
  swapCount: integer().notNull(),
  /** Null until the first swap in pools from before block 629,533, whose `PoolInitialized` had only the tick. */
  sqrtRatio: bignum(),
  tick: bignum().notNull(),
  liquidity: bignum().notNull(),
});

export const poolRelations = relations(pool, ({ many }) => ({ swaps: many(swap) }));

/** Amounts are signed: positive is paid into the pool, negative taken out of it. */
export const swap = pgTable(
  "swap",
  {
    id: text().primaryKey(),
    poolId: text().notNull(),
    block: integer().notNull(),
    locker: hex().notNull(),
    amount0: bignum().notNull(),
    amount1: bignum().notNull(),
    sqrtRatioAfter: bignum().notNull(),
    tickAfter: bignum().notNull(),
    liquidityAfter: bignum().notNull(),
  },
  (t) => [index().on(t.poolId)],
);

export const swapRelations = relations(swap, ({ one }) => ({
  pool: one(pool, { fields: [swap.poolId], references: [pool.id] }),
}));
