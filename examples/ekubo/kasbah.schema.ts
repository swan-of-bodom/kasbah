import {
  bignum,
  doublePrecision,
  hex,
  integer,
  pgTable,
  primaryKey,
  text,
} from "../../src/index.ts";

export const pools = pgTable("pools", {
  id: text().primaryKey(),
  token0: hex().notNull(),
  token1: hex().notNull(),
  fee: bignum().notNull(),
  tickSpacing: bignum().notNull(),
  extension: hex().notNull(),
  createdAt: integer().notNull(),
  swaps: integer().notNull(),
  volume0: bignum().notNull(),
  volume1: bignum().notNull(),
  sqrtRatio: bignum(),
  tick: bignum().notNull(),
  liquidity: bignum().notNull(),
  /** Tokens the pool holds: what positions and swaps paid in, less what was taken out. */
  balance0: bignum().notNull(),
  balance1: bignum().notNull(),
});

/**
 * Per pool, per hour (3600) and day (86400) from `time` (unix seconds): price as token1 per token0 in raw units,
 * swaps, volume and swap fees in each token, and the pool's balances after the candle's last event (TVL in tokens).
 */
export const candles = pgTable(
  "candles",
  {
    pool: text().notNull(),
    interval: integer().notNull(),
    time: integer().notNull(),
    open: doublePrecision().notNull(),
    high: doublePrecision().notNull(),
    low: doublePrecision().notNull(),
    close: doublePrecision().notNull(),
    swaps: integer().notNull(),
    volume0: bignum().notNull(),
    volume1: bignum().notNull(),
    fees0: bignum().notNull(),
    fees1: bignum().notNull(),
    balance0: bignum().notNull(),
    balance1: bignum().notNull(),
  },
  (t) => [primaryKey({ columns: [t.pool, t.interval, t.time] })],
);

/** Protocol totals, one row. */
export const totals = pgTable("totals", {
  id: text().primaryKey(),
  pools: integer().notNull(),
  swaps: integer().notNull(),
  positionUpdates: integer().notNull(),
});

/** `totals` every 1,800 blocks (about 50 minutes). */
export const history = pgTable("history", {
  block: integer().primaryKey(),
  timestamp: integer().notNull(),
  pools: integer().notNull(),
  swaps: integer().notNull(),
  positionUpdates: integer().notNull(),
});
