import { foreignKey, index, integer, pgTable, primaryKey, text, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { expect, test } from "vitest";
import { createTableSql, indexSql, primaryKeySql, tableInfo } from "../src/db/table.ts";

test("key columns are NOT NULL without the key too, composite keys included", () => {
  const t = pgTable("pairs", { a: text(), b: integer(), note: text() }, (t) => [primaryKey({ columns: [t.a, t.b] })]);
  expect(createTableSql(tableInfo(t), { primaryKey: false })).toBe(`CREATE TABLE IF NOT EXISTS "pairs" ("a" text NOT NULL, "b" integer NOT NULL, "note" text)`);
  expect(primaryKeySql(tableInfo(t))).toEqual([
    `CREATE UNIQUE INDEX IF NOT EXISTS "pairs_pkey" ON "pairs" ("a", "b")`,
    `ALTER TABLE "pairs" ADD CONSTRAINT "pairs_pkey" PRIMARY KEY USING INDEX "pairs_pkey"`,
  ]);
});

test("indexes and unique constraints become indexes", () => {
  const t = pgTable("swaps", { id: text().primaryKey(), pool: text().notNull(), block: integer().notNull(), tx: text().unique() }, (t) => [
    index().on(t.pool, t.block),
    uniqueIndex("by_block").on(t.block),
    index("hashed").using("hash", t.pool),
    unique().on(t.pool, t.tx),
  ]);
  expect(indexSql(tableInfo(t))).toEqual([
    `CREATE INDEX IF NOT EXISTS "swaps_pool_block_index" ON "swaps" ("pool", "block")`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "by_block" ON "swaps" ("block")`,
    `CREATE INDEX IF NOT EXISTS "hashed" ON "swaps" USING hash ("pool")`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "swaps_pool_tx_unique" ON "swaps" ("pool", "tx")`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "swaps_tx_unique" ON "swaps" ("tx")`,
  ]);
});

test("what kasbah can't create as written is refused, not dropped", () => {
  const id = { id: text().primaryKey(), name: text().notNull(), n: integer().notNull() };
  const refused = (extra: (t: any) => unknown[]) => () => indexSql(tableInfo(pgTable("t", { ...id }, extra as never)));
  expect(refused((t) => [index().on(t.name.desc())])).toThrow("t: index ordering and operator classes are not supported");
  expect(refused((t) => [index().using("gin", t.name.op("gin_trgm_ops"))])).toThrow("operator classes");
  expect(refused((t) => [index().on(t.n).where(t.n)])).toThrow("partial indexes");
  const parent = pgTable("parent", { id: text().primaryKey() });
  expect(refused((t) => [foreignKey({ columns: [t.name], foreignColumns: [parent.id] })])).toThrow("foreign keys");
});
