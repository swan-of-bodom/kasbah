import { bignum, hex, index, integer, pgTable, relations, text } from "kasbah";

export const pair = pgTable("pair", {
  address: hex().primaryKey(),
  token0: hex().notNull(),
  token1: hex().notNull(),
  createdAt: integer().notNull(),
  swapCount: integer().notNull(),
  volume0: bignum().notNull(),
  volume1: bignum().notNull(),
  reserve0: bignum().notNull(),
  reserve1: bignum().notNull(),
});

export const pairRelations = relations(pair, ({ many }) => ({ swaps: many(swap) }));

export const swap = pgTable(
  "swap",
  {
    id: text().primaryKey(),
    pairAddress: hex().notNull(),
    block: integer().notNull(),
    sender: hex().notNull(),
    amount0In: bignum().notNull(),
    amount1In: bignum().notNull(),
    amount0Out: bignum().notNull(),
    amount1Out: bignum().notNull(),
  },
  (t) => [index().on(t.pairAddress)],
);

export const swapRelations = relations(swap, ({ one }) => ({
  pair: one(pair, { fields: [swap.pairAddress], references: [pair.address] }),
}));
