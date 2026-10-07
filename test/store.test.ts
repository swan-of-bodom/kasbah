import { drizzle } from "drizzle-orm/node-postgres";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { Store } from "../src/db/store.ts";
import { createTableSql, tableInfo } from "../src/db/table.ts";
import { bignum } from "../src/schema.ts";

const url = process.env.DATABASE_URL;
const schema = "kasbah_test_store";

const balances = pgTable("balances", {
  owner: text().primaryKey(),
  amount: bignum().notNull(),
  updates: integer().notNull(),
  note: text(),
});

let pool: pg.Pool;

beforeAll(async () => {
  if (url === undefined) return;
  pool = new pg.Pool({ connectionString: url, max: 4, options: `-c search_path=${schema}` });
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`);
});

afterAll(async () => {
  if (url === undefined) return;
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.end();
});

async function inTransaction(body: (c: pg.PoolClient) => Promise<void>) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await body(c);
    await c.query("COMMIT");
  } finally {
    c.release();
  }
}

const snapshot = async () =>
  (await pool.query(`SELECT owner, amount::text, updates, note FROM balances ORDER BY owner`)).rows as unknown[];

test.skipIf(url === undefined)("the undo journal reverts random writes to any earlier block", async () => {
  await pool.query(`DROP TABLE IF EXISTS balances, _kasbah_journal`);
  await pool.query(createTableSql(tableInfo(balances)));
  await pool.query(`CREATE TABLE _kasbah_journal (block integer NOT NULL, seq bigserial, tbl text NOT NULL, pk jsonb NOT NULL, before jsonb)`);

  let s = 7;
  const rand = (n: number) => Math.floor(((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * n);
  const owners = Array.from({ length: 12 }, (_, i) => `0x${i}`);

  // Rows written before live mode, never journaled.
  const store = new Store(drizzle(pool), [balances], { complete: true });
  for (const owner of owners.slice(0, 6)) await store.db.insert(balances).values({ owner, amount: 10n ** 30n, updates: 0, note: "a\tb\\c\n" });
  await inTransaction((c) => store.flush(c));

  store.journal = true;
  const snapshots = new Map<number, unknown[]>([[100, await snapshot()]]);
  for (let block = 101; block <= 130; block++) {
    for (let i = 0; i < 1 + rand(6); i++) {
      const owner = owners[rand(owners.length)]!;
      const op = rand(4);
      const row = await store.db.find(balances, { owner });
      if (op === 0) {
        await store.db.insert(balances).values({ owner, amount: BigInt(block), updates: 1, note: null }).onConflictDoUpdate((r) => ({ amount: r.amount + 1n, updates: r.updates + 1 }));
      } else if (op === 1 && row !== null) {
        await store.db.update(balances, { owner }).set((r) => ({ amount: r.amount * 2n, updates: r.updates + 1, note: `b${block}` }));
      } else if (op === 2) {
        await store.db.delete(balances, { owner });
      } else if (row === null) {
        await store.db.insert(balances).values({ owner, amount: 1n, updates: 0, note: "new" });
      }
    }
    await inTransaction((c) => store.flush(c, block));
    snapshots.set(block, await snapshot());
  }

  for (const ancestor of [125, 117, 100]) {
    await inTransaction(async (c) => void (await store.revert(c, ancestor)));
    expect(await snapshot()).toEqual(snapshots.get(ancestor));
  }
  expect((await pool.query(`SELECT count(*)::int AS n FROM _kasbah_journal`)).rows[0].n).toBe(0);

  // After a revert the cache is gone: reads come from the database again.
  expect(await store.db.find(balances, { owner: "0x0" })).toEqual({ owner: "0x0", amount: 10n ** 30n, updates: 0, note: "a\tb\\c\n" });
});

test.skipIf(url === undefined)("past the cache limit: plain inserts make no queries, duplicates fail at flush, updates still read", async () => {
  await pool.query(`DROP TABLE IF EXISTS balances`);
  await pool.query(createTableSql(tableInfo(balances)));
  let queries = 0;
  const counting = { ...pool, query: (...a: unknown[]) => (queries++, (pool.query as (...x: unknown[]) => unknown)(...a)) } as unknown as pg.Pool;
  const store = new Store(drizzle(counting), [balances], { complete: true, maxCachedRows: 10 });
  const row = (i: number) => ({ owner: `0x${i.toString(16).padStart(4, "0")}`, amount: BigInt(i), updates: 0 });

  for (let i = 0; i < 30; i++) await store.db.insert(balances).values(row(i));
  await inTransaction((c) => store.flush(c));
  // Over the limit: the oldest rows are dropped, the table is no longer known in full.
  queries = 0;
  for (let i = 30; i < 60; i++) await store.db.insert(balances).values(row(i));
  expect(queries).toBe(0);
  // A key inserted twice in one batch is still caught at once.
  await expect(store.db.insert(balances).values(row(59))).rejects.toThrow("already exists");
  await inTransaction((c) => store.flush(c));

  // An evicted row is read back for an update.
  expect((await store.db.update(balances, { owner: row(1).owner }).set((r) => ({ updates: r.updates + 1 }))).updates).toBe(1);
  expect(queries).toBeGreaterThan(0);
  await inTransaction((c) => store.flush(c));
  expect((await pool.query(`SELECT count(*)::int AS n, sum(updates)::int AS u FROM balances`)).rows[0]).toEqual({ n: 60, u: 1 });

  // An evicted row inserted again: the primary key refuses it when the batch is written.
  await store.db.insert(balances).values(row(2));
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await expect(store.flush(c)).rejects.toThrow(/balances: insert of a key that already exists \(Key \(owner\)=\(0x0002\)/);
    await c.query("ROLLBACK");
  } finally {
    c.release();
  }
});

test.skipIf(url === undefined)("an unkeyed table gets its primary key when first needed, and a duplicate shows then", async () => {
  await pool.query(`DROP TABLE IF EXISTS balances`);
  const info = tableInfo(balances);
  const hasKey = async () => (await pool.query(`SELECT 1 FROM pg_constraint WHERE conrelid = 'balances'::regclass AND contype = 'p'`)).rowCount === 1;
  const row = (i: number) => ({ owner: `0x${i}`, amount: BigInt(i), updates: 0 });

  // Inserts only: no key.
  await pool.query(createTableSql(info, { primaryKey: false }));
  let store = new Store(drizzle(pool), [balances], { complete: true, unkeyed: new Set(["balances"]) });
  for (let i = 0; i < 5; i++) await store.db.insert(balances).values(row(i));
  await inTransaction((c) => store.flush(c));
  expect(await hasKey()).toBe(false);
  // The first upsert adds it.
  await store.db.update(balances, { owner: "0x1" }).set({ updates: 1 });
  await inTransaction((c) => store.flush(c));
  expect(await hasKey()).toBe(true);

  // A read from Postgres adds it too.
  await pool.query(`DROP TABLE balances`);
  await pool.query(createTableSql(info, { primaryKey: false }));
  await pool.query(`INSERT INTO balances VALUES ('0x9', 9, 0, null)`);
  store = new Store(drizzle(pool), [balances], { complete: false, unkeyed: new Set(["balances"]) });
  expect((await store.db.find(balances, { owner: "0x9" }))?.amount).toBe(9n);
  expect(await hasKey()).toBe(true);

  // A key inserted twice without the cache knowing: refused when the key is built.
  await pool.query(`DROP TABLE balances`);
  await pool.query(createTableSql(info, { primaryKey: false }));
  await pool.query(`INSERT INTO balances VALUES ('0x3', 3, 0, null)`);
  store = new Store(drizzle(pool), [balances], { complete: false, unkeyed: new Set(["balances"]) });
  await store.db.insert(balances).values(row(3));
  await inTransaction((c) => store.flush(c));
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await expect(store.addKeys(c)).rejects.toThrow(/balances: a key was inserted twice \(Key \(owner\)=\(0x3\) is duplicated/);
    await c.query("ROLLBACK");
  } finally {
    c.release();
  }
});
