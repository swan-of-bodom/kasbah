import { drizzle } from "drizzle-orm/node-postgres";
import { integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { bignum } from "../../src/config/schema.ts";
import { Store } from "../../src/db/store.ts";
import { createTableSql, frozenJson, tableInfo } from "../../src/db/table.ts";
import { approxBytes } from "../../src/utils/memory.ts";

const url = process.env.DATABASE_URL;
const schema = "kasbah_test_store";

const balances = pgTable("balances", {
  owner: text().primaryKey(),
  amount: bignum().notNull(),
  updates: integer().notNull(),
  note: text(),
});
const transfers = pgTable("transfers", { id: text().primaryKey(), amount: bignum().notNull() });

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
  (await pool.query(`SELECT owner, amount::text, updates, note FROM balances ORDER BY owner`))
    .rows as unknown[];

test.skipIf(url === undefined)(
  "the undo journal reverts random writes to any earlier block",
  async () => {
    await pool.query(`DROP TABLE IF EXISTS balances, _kasbah_journal`);
    await pool.query(createTableSql(tableInfo(balances)));
    await pool.query(
      `CREATE TABLE _kasbah_journal (block integer NOT NULL, seq bigserial, tbl text NOT NULL, pk jsonb NOT NULL, before jsonb)`,
    );

    let s = 7;
    const rand = (n: number) =>
      Math.floor(((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * n);
    const owners = Array.from({ length: 12 }, (_, i) => `0x${i}`);

    const store = new Store(drizzle(pool), [balances], { complete: true });
    for (const owner of owners.slice(0, 6))
      await store.db
        .insert(balances)
        .values({ owner, amount: 10n ** 30n, updates: 0, note: "a\tb\\c\n" });
    await inTransaction((c) => store.flush(c));

    store.journal = true;
    const snapshots = new Map<number, unknown[]>([[100, await snapshot()]]);
    for (let block = 101; block <= 130; block++) {
      for (let i = 0; i < 1 + rand(6); i++) {
        const owner = owners[rand(owners.length)]!;
        const op = rand(4);
        const row = await store.db.find(balances, { owner });
        if (op === 0) {
          await store.db
            .insert(balances)
            .values({ owner, amount: BigInt(block), updates: 1, note: null })
            .onConflictDoUpdate((r) => ({ amount: r.amount + 1n, updates: r.updates + 1 }));
        } else if (op === 1 && row !== null) {
          await store.db
            .update(balances, { owner })
            .set((r) => ({ amount: r.amount * 2n, updates: r.updates + 1, note: `b${block}` }));
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

    expect(await store.db.find(balances, { owner: "0x0" })).toEqual({
      owner: "0x0",
      amount: 10n ** 30n,
      updates: 0,
      note: "a\tb\\c\n",
    });
  },
);

test.skipIf(url === undefined)(
  "past the cache limit: plain inserts make no queries, duplicates fail at flush, updates still read",
  async () => {
    await pool.query(`DROP TABLE IF EXISTS balances`);
    await pool.query(createTableSql(tableInfo(balances)));
    let queries = 0;
    const counting = {
      ...pool,
      query: (...a: unknown[]) => {
        queries++;
        return (pool.query as (...x: unknown[]) => unknown)(...a);
      },
    } as unknown as pg.Pool;
    const row = (i: number) => ({
      owner: `0x${i.toString(16).padStart(4, "0")}`,
      amount: BigInt(i),
      updates: 0,
    });
    const store = new Store(drizzle(counting), [balances], {
      complete: true,
      maxCachedBytes: 10 * (approxBytes(row(0)) + 64),
    });

    for (let i = 0; i < 30; i++) await store.db.insert(balances).values(row(i));
    await inTransaction((c) => store.flush(c));
    queries = 0;
    for (let i = 30; i < 60; i++) await store.db.insert(balances).values(row(i));
    expect(queries).toBe(0);
    await expect(store.db.insert(balances).values(row(59))).rejects.toThrow("already exists");
    await inTransaction((c) => store.flush(c));

    expect(
      (
        await store.db
          .update(balances, { owner: row(1).owner })
          .set((r) => ({ updates: r.updates + 1 }))
      ).updates,
    ).toBe(1);
    expect(queries).toBeGreaterThan(0);
    await inTransaction((c) => store.flush(c));
    expect(
      (await pool.query(`SELECT count(*)::int AS n, sum(updates)::int AS u FROM balances`)).rows[0],
    ).toEqual({ n: 60, u: 1 });

    await store.db.insert(balances).values(row(2));
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await expect(store.flush(c)).rejects.toThrow(
        /balances: insert of a key that already exists \(Key \(owner\)=\(0x0002\)/,
      );
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  },
);

test.skipIf(url === undefined)(
  "the cache limit is in bytes for all tables together, and the tables read least go first",
  async () => {
    await pool.query(`DROP TABLE IF EXISTS balances; DROP TABLE IF EXISTS transfers`);
    await pool.query(createTableSql(tableInfo(balances)));
    await pool.query(createTableSql(tableInfo(transfers)));
    const owner = (i: number) => `0x${i.toString(16).padStart(4, "0")}`;
    const balance = (i: number) => ({ owner: owner(i), amount: 0n, updates: 0 });
    const budget = 200 * (approxBytes(balance(0)) + 64);
    let queries = 0;
    const counting = {
      ...pool,
      query: (...a: unknown[]) => {
        queries++;
        return (pool.query as (...x: unknown[]) => unknown)(...a);
      },
    } as unknown as pg.Pool;
    const store = new Store(drizzle(counting), [balances, transfers], {
      complete: true,
      maxCachedBytes: budget,
    });
    for (let i = 0; i < 50; i++) await store.db.insert(balances).values(balance(i));
    for (let block = 0; block < 20; block++) {
      for (let i = 0; i < 50; i++) {
        await store.db
          .update(balances, { owner: owner(i) })
          .set((r) => ({ updates: r.updates + 1 }));
        await store.db
          .insert(transfers)
          .values({ id: `${block}:${i}`, amount: BigInt(block * 50 + i) });
      }
      await inTransaction((c) => store.flush(c));
    }
    queries = 0;
    for (let i = 0; i < 50; i++)
      expect((await store.db.find(balances, { owner: owner(i) }))?.updates).toBe(20);
    expect(queries).toBe(0);
    expect(
      (await pool.query(`SELECT count(*)::int AS n FROM transfers`)).rows[0].n +
        (await pool.query(`SELECT sum(updates)::int AS u FROM balances`)).rows[0].u,
    ).toBe(1000 + 1000);
  },
);

test.skipIf(url === undefined)(
  "pendingBytes counts the rows a flush would write, once per key, and is zero after it",
  async () => {
    await pool.query(`DROP TABLE IF EXISTS balances`);
    await pool.query(createTableSql(tableInfo(balances)));
    const store = new Store(drizzle(pool), [balances], { complete: true });
    const row = (i: number, updates = 0) => ({ owner: `0x${i}`, amount: BigInt(i), updates });
    for (let i = 0; i < 10; i++) await store.db.insert(balances).values(row(i));
    const ten = store.pendingBytes;
    expect(ten).toBe(
      Array.from({ length: 10 }, (_, i) => approxBytes(row(i))).reduce((a, b) => a + b),
    );
    await store.db.update(balances, { owner: "0x3" }).set({ updates: 1 });
    expect(store.pendingBytes).toBe(ten);
    await store.db.delete(balances, { owner: "0x4" });
    expect(store.pendingBytes).toBe(ten - approxBytes(row(4)));
    await inTransaction((c) => store.flush(c));
    expect(store.pendingBytes).toBe(0);
  },
);

test.skipIf(url === undefined)(
  "an unkeyed table gets its primary key when first needed, and a duplicate shows then",
  async () => {
    await pool.query(`DROP TABLE IF EXISTS balances`);
    const info = tableInfo(balances);
    const hasKey = async () =>
      (
        await pool.query(
          `SELECT 1 FROM pg_constraint WHERE conrelid = 'balances'::regclass AND contype = 'p'`,
        )
      ).rowCount === 1;
    const row = (i: number) => ({ owner: `0x${i}`, amount: BigInt(i), updates: 0 });

    await pool.query(createTableSql(info, { primaryKey: false }));
    let store = new Store(drizzle(pool), [balances], {
      complete: true,
      unkeyed: new Set(["balances"]),
    });
    for (let i = 0; i < 5; i++) await store.db.insert(balances).values(row(i));
    await inTransaction((c) => store.flush(c));
    expect(await hasKey()).toBe(false);
    await store.db.update(balances, { owner: "0x1" }).set({ updates: 1 });
    await inTransaction((c) => store.flush(c));
    expect(await hasKey()).toBe(true);

    await pool.query(`DROP TABLE balances`);
    await pool.query(createTableSql(info, { primaryKey: false }));
    await pool.query(`INSERT INTO balances VALUES ('0x9', 9, 0, null)`);
    store = new Store(drizzle(pool), [balances], {
      complete: false,
      unkeyed: new Set(["balances"]),
    });
    expect((await store.db.find(balances, { owner: "0x9" }))?.amount).toBe(9n);
    expect(await hasKey()).toBe(true);

    await pool.query(`DROP TABLE balances`);
    await pool.query(createTableSql(info, { primaryKey: false }));
    await pool.query(`INSERT INTO balances VALUES ('0x3', 3, 0, null)`);
    store = new Store(drizzle(pool), [balances], {
      complete: false,
      unkeyed: new Set(["balances"]),
    });
    await store.db.insert(balances).values(row(3));
    await inTransaction((c) => store.flush(c));
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await expect(store.addKey(balances, c)).rejects.toThrow(
        /balances: a handler inserted a key twice \(Key \(owner\)=\(0x3\) is duplicated\.\); fix the handler and run with reset/,
      );
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  },
);

test("frozenJson: a frozen copy, bigints as decimal strings, the original untouched", () => {
  const args = { key: { fee: 2n ** 127n, tick: { mag: 5n, sign: false } }, list: [1n, 2], at: 3 };
  const out = frozenJson(args) as typeof args;
  expect(out).toEqual({
    key: { fee: (2n ** 127n).toString(), tick: { mag: "5", sign: false } },
    list: ["1", 2],
    at: 3,
  });
  expect(Object.isFrozen(out) && Object.isFrozen(out.key.tick) && Object.isFrozen(out.list)).toBe(
    true,
  );
  expect(args.key.fee).toBe(2n ** 127n);
  expect(Object.isFrozen(args.key)).toBe(false);
});

const swaps = pgTable("swaps", { id: text().primaryKey(), params: jsonb() });

test.skipIf(url === undefined)(
  "a jsonb column takes bigints, and reads the same from memory and from Postgres",
  async () => {
    await pool.query(`DROP TABLE IF EXISTS swaps`);
    await pool.query(createTableSql(tableInfo(swaps)));
    const params = { amount: { mag: 10n ** 30n, sign: true }, sqrt_ratio_limit: 2n ** 200n };
    const expected = {
      amount: { mag: (10n ** 30n).toString(), sign: true },
      sqrt_ratio_limit: (2n ** 200n).toString(),
    };
    const store = new Store(drizzle(pool), [swaps], { complete: false });
    await store.db.insert(swaps).values({ id: "a", params });
    await store.db.insert(swaps).values({ id: "b", params: null });
    expect((await store.db.find(swaps, { id: "a" }))?.params).toEqual(expected);
    await inTransaction((c) => store.flush(c));
    expect((await pool.query(`SELECT params FROM swaps WHERE id = 'a'`)).rows[0].params).toEqual(
      expected,
    );
    expect(
      (await new Store(drizzle(pool), [swaps], { complete: false }).db.find(swaps, { id: "a" }))
        ?.params,
    ).toEqual(expected);
  },
);

test.skipIf(url === undefined)(
  "rows the store returns are read-only, so a handler can't change the cache behind Postgres's back",
  async () => {
    await pool.query(`DROP TABLE IF EXISTS swaps`);
    await pool.query(createTableSql(tableInfo(swaps)));
    const store = new Store(drizzle(pool), [swaps], { complete: true });
    const params = { amount: { mag: "1" }, path: ["a"] };
    const inserted = await store.db.insert(swaps).values({ id: "a", params });
    const found = (await store.db.find(swaps, { id: "a" }))!;
    const updated = await store.db.update(swaps, { id: "a" }).set({ params: { path: ["b"] } });
    for (const row of [inserted, found, updated]) {
      expect(() => {
        (row as { id: string }).id = "z";
      }).toThrow(TypeError);
      expect(() => {
        (row.params as { path: string[] }).path.push("x");
      }).toThrow(TypeError);
    }
    // What the handler passed in stays its own.
    params.path.push("c");
    params.amount.mag = "2";
    expect(params).toEqual({ amount: { mag: "2" }, path: ["a", "c"] });
    expect(inserted.params).toEqual({ amount: { mag: "1" }, path: ["a"] });
    expect((await store.db.find(swaps, { id: "a" }))?.params).toEqual({ path: ["b"] });
    await inTransaction((c) => store.flush(c));
    expect((await pool.query(`SELECT params FROM swaps WHERE id = 'a'`)).rows[0].params).toEqual({
      path: ["b"],
    });
    const fromDb = (await new Store(drizzle(pool), [swaps], { complete: false }).db.find(swaps, {
      id: "a",
    }))!;
    expect(() => {
      (fromDb as { id: string }).id = "z";
    }).toThrow(TypeError);
  },
);
