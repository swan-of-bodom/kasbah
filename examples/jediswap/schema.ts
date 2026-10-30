import { bignum, hex, integer, pgTable, relations, text } from "../../src/index.ts";

export const pairs = pgTable("pairs", {
  address: hex().primaryKey(),
  token0: hex().notNull(),
  token1: hex().notNull(),
  createdAt: integer().notNull(),
  swaps: integer().notNull(),
  volume0: bignum().notNull(),
  volume1: bignum().notNull(),
  reserve0: bignum().notNull(),
  reserve1: bignum().notNull(),
});

export const swaps = pgTable("swaps", {
  id: text().primaryKey(),
  pairAddress: hex().notNull(),
  block: integer().notNull(),
  sender: hex().notNull(),
  amount0In: bignum().notNull(),
  amount1In: bignum().notNull(),
  amount0Out: bignum().notNull(),
  amount1Out: bignum().notNull(),
});

export const pairsRelations = relations(pairs, ({ many }) => ({ swapList: many(swaps) }));
export const swapsRelations = relations(swaps, ({ one }) => ({
  pair: one(pairs, { fields: [swaps.pairAddress], references: [pairs.address] }),
}));
