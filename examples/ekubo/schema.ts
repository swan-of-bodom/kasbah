import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { bignum, hex } from "../../src/index.ts";

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
});
