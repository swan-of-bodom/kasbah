import { bignum, doublePrecision, integer, pgTable, primaryKey, text } from "kasbah";

/** A pair's median price at a block, as the oracle answered at the end of it. */
export const price = pgTable(
  "price",
  {
    pair: text().notNull(),
    block: integer().notNull(),
    /** The block's, unix seconds. */
    timestamp: integer().notNull(),
    /** The oracle's integer: `value` is `price / 10^decimals`. */
    price: bignum().notNull(),
    decimals: integer().notNull(),
    value: doublePrecision().notNull(),
    /** When the oracle last got a price for the pair, unix seconds. */
    updatedAt: integer().notNull(),
    sources: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.pair, t.block] })],
);
