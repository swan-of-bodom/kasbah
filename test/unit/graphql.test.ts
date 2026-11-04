import { relations } from "drizzle-orm";
import { integer, jsonb, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { db, graphql } from "../../src/api/index.ts";
import { Api } from "../../src/api/server.ts";
import { bignum } from "../../src/config/schema.ts";
import { createTableSql, tableInfo } from "../../src/db/table.ts";

const url = process.env.DATABASE_URL;
const schema = "kasbah_test_graphql";

const pools = pgTable("pools", {
  id: text().primaryKey(),
  swaps: integer().notNull(),
  volume: bignum().notNull(),
  note: text(),
  extra: jsonb(),
});
const positions = pgTable(
  "positions",
  { owner: text().notNull(), pool: text().notNull(), liquidity: bignum().notNull() },
  (t) => [primaryKey({ columns: [t.owner, t.pool] })],
);

const poolsRelations = relations(pools, ({ many }) => ({ positions: many(positions) }));
const positionsRelations = relations(positions, ({ one }) => ({
  poolInfo: one(pools, { fields: [positions.pool], references: [pools.id] }),
}));

let api: Api;
let base: string;
const rows = Array.from({ length: 17 }, (_, i) => ({
  id: `p${String(i).padStart(2, "0")}`,
  swaps: (i * 7) % 5,
  volume: 10n ** 40n + BigInt(i),
  note: i % 3 === 0 ? null : `n${i}`,
}));

beforeAll(async () => {
  if (url === undefined) return;
  const owner = new pg.Pool({ connectionString: url, max: 1 });
  await owner.query(
    `DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}; SET search_path TO ${schema}`,
  );
  const c = await owner.connect();
  await c.query(`SET search_path TO ${schema}`);
  for (const t of [pools, positions]) await c.query(createTableSql(tableInfo(t)));
  await c.query(
    `CREATE TABLE _kasbah_meta (key text PRIMARY KEY, value jsonb NOT NULL); INSERT INTO _kasbah_meta VALUES ('checkpoint', '42'), ('phase', '"live"')`,
  );
  await c.query(`CREATE TABLE _kasbah_journal (block integer)`);
  for (const r of rows)
    await c.query(`INSERT INTO pools VALUES ($1, $2, $3, $4, $5)`, [
      r.id,
      r.swaps,
      r.volume.toString(),
      r.note,
      { i: r.id },
    ]);
  await c.query(
    `INSERT INTO positions VALUES ('0xa', 'p01', 5), ('0xa', 'p02', 6), ('0xb', 'p01', 7)`,
  );
  c.release();
  await owner.end();
  const tables = { pools, positions, poolsRelations, positionsRelations };
  const app = new Hono().use("/graphql", graphql({ db, schema: tables }));
  api = await Api.start({ database: url, schema, tables, port: 0, app });
  base = `http://127.0.0.1:${api.port}`;
});

afterAll(async () => {
  if (url === undefined) return;
  await api.close();
  const owner = new pg.Pool({ connectionString: url, max: 1 });
  await owner.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await owner.end();
});

const gql = async (query: string, variables?: Record<string, unknown>) =>
  (await (
    await fetch(`${base}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    })
  ).json()) as any;

test.skipIf(url === undefined)("GET opens GraphiQL", async () => {
  const page = await fetch(`${base}/graphql`);
  expect(page.headers.get("content-type")).toContain("text/html");
  expect(await page.text()).toContain("GraphiQL.createFetcher");
});

test.skipIf(url === undefined)("GraphQL: one row by primary key, composite keys too", async () => {
  expect(await gql(`{ pool(id: "p04") { id swaps volume note extra } }`)).toEqual({
    data: {
      pool: {
        id: "p04",
        swaps: 3,
        volume: (10n ** 40n + 4n).toString(),
        note: "n4",
        extra: { i: "p04" },
      },
    },
  });
  expect(await gql(`{ pool(id: "nope") { id } }`)).toEqual({ data: { pool: null } });
  expect(await gql(`{ position(owner: "0xa", pool: "p02") { liquidity } }`)).toEqual({
    data: { position: { liquidity: "6" } },
  });
});

test.skipIf(url === undefined)("GraphQL: filters", async () => {
  const ids = async (where: string) =>
    (await gql(`{ pools(where: ${where}, limit: 100) { items { id } } }`)).data.pools.items.map(
      (i: { id: string }) => i.id,
    );
  const all = rows.map((r) => r.id);
  expect(await ids(`{ swaps: 0 }`)).toEqual(rows.filter((r) => r.swaps === 0).map((r) => r.id));
  expect(await ids(`{ volume_gt: "${10n ** 40n + 14n}" }`)).toEqual(["p15", "p16"]);
  expect(await ids(`{ id_in: ["p01", "p03", "zz"] }`)).toEqual(["p01", "p03"]);
  expect(await ids(`{ note: null }`)).toEqual(rows.filter((r) => r.note === null).map((r) => r.id));
  expect(await ids(`{ note_not: null, swaps_lte: 1 }`)).toEqual(
    rows.filter((r) => r.note !== null && r.swaps <= 1).map((r) => r.id),
  );
  expect(
    await ids(`{ OR: [{ id: "p02" }, { id_not_in: ${JSON.stringify(all.slice(1))} }] }`),
  ).toEqual(["p00", "p02"]);
});

test.skipIf(url === undefined).each(["asc", "desc"])(
  "GraphQL: paging by a non-unique column, %s, visits every row once",
  async (dir) => {
    const seen: string[] = [];
    let after: string | null = null;
    for (let i = 0; i < 10; i++) {
      const r: any = await gql(
        `query($after: String) { pools(orderBy: swaps, orderDirection: ${dir}, limit: 3, after: $after) { items { id swaps } pageInfo { hasNextPage endCursor } } }`,
        { after },
      );
      if (r.errors) throw new Error(JSON.stringify(r.errors));
      seen.push(...r.data.pools.items.map((p: { id: string }) => p.id));
      if (!r.data.pools.pageInfo.hasNextPage) break;
      after = r.data.pools.pageInfo.endCursor;
    }
    const sign = dir === "asc" ? 1 : -1;
    const expected = [...rows]
      .sort((a, b) => sign * (a.swaps - b.swaps || a.id.localeCompare(b.id)))
      .map((r) => r.id);
    expect(seen).toEqual(expected);
  },
);

test.skipIf(url === undefined)(
  "GraphQL: bad input is a client error, not an internal one",
  async () => {
    expect((await gql(`{ pools(after: "garbage") { items { id } } }`)).errors[0].message).toBe(
      "invalid cursor",
    );
    expect((await gql(`{ pools(limit: 5000) { items { id } } }`)).errors[0].message).toMatch(
      /limit must be/,
    );
    expect(
      (await gql(`{ pools(where: { volume: "1.5" }) { items { id } } }`)).errors[0].message,
    ).toMatch(/decimal string/);
    expect((await gql(`{ nothing }`)).errors[0].message).toMatch(/Cannot query field/);
    expect((await gql(`{ _meta { checkpoint phase } }`)).data._meta).toEqual({
      checkpoint: 42,
      phase: "live",
    });
  },
);

test.skipIf(url === undefined)(
  "GraphQL relations: to-one in a list, to-many with filters and paging",
  async () => {
    const owner = new pg.Pool({ connectionString: url, max: 1 });
    const { rows } = await owner.query<{ id: string; swaps: number }>(
      `SELECT id, swaps FROM ${schema}.pools WHERE id IN ('p01', 'p02')`,
    );
    await owner.end();
    const swaps = Object.fromEntries(rows.map((r) => [r.id, r.swaps]));
    expect(
      await gql(
        `{ positions(orderBy: liquidity, where: { owner_in: ["0xa", "0xb"] }) { items { owner liquidity poolInfo { id swaps } } } }`,
      ),
    ).toEqual({
      data: {
        positions: {
          items: [
            { owner: "0xa", liquidity: "5", poolInfo: { id: "p01", swaps: swaps.p01 } },
            { owner: "0xa", liquidity: "6", poolInfo: { id: "p02", swaps: swaps.p02 } },
            { owner: "0xb", liquidity: "7", poolInfo: { id: "p01", swaps: swaps.p01 } },
          ],
        },
      },
    });
    const first = await gql(
      `{ pool(id: "p01") { positions(orderBy: liquidity, orderDirection: desc, limit: 1) { items { owner } pageInfo { hasNextPage endCursor } } } }`,
    );
    expect(first.data.pool.positions.items).toEqual([{ owner: "0xb" }]);
    expect(first.data.pool.positions.pageInfo.hasNextPage).toBe(true);
    const next = await gql(
      `query ($after: String) { pool(id: "p01") { positions(orderBy: liquidity, orderDirection: desc, after: $after) { items { owner } pageInfo { hasNextPage } } } }`,
      { after: first.data.pool.positions.pageInfo.endCursor },
    );
    expect(next.data.pool.positions).toEqual({
      items: [{ owner: "0xa" }],
      pageInfo: { hasNextPage: false },
    });
    expect(
      (
        await gql(
          `{ pool(id: "p01") { positions(where: { liquidity_gt: "5" }) { items { owner } } } }`,
        )
      ).data.pool.positions.items,
    ).toEqual([{ owner: "0xb" }]);
    expect(
      (await gql(`{ pool(id: "p09") { positions { items { owner } } } }`)).data.pool.positions
        .items,
    ).toEqual([]);
  },
);

test.skipIf(url === undefined)(
  "GraphQL relations: to-one and to-many are batched per level, and an operation has a token limit",
  async () => {
    const owner = new pg.Pool({ connectionString: url, max: 1 });
    await owner.query(
      `INSERT INTO ${schema}.positions SELECT 'o' || i, 'p' || lpad((i % 17)::text, 2, '0'), i FROM generate_series(1, 600) i`,
    );
    await owner.end();
    // 600 parents, one statement for their pools: without batching this is 601 statements, over the budget.
    const r = await gql(
      `{ positions(limit: 1000, where: { owner_not_in: ["0xa", "0xb"] }) { items { owner poolInfo { id } } } }`,
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.positions.items).toHaveLength(600);
    expect(
      r.data.positions.items.every(
        (p: any) => p.poolInfo.id === `p${String(Number(p.owner.slice(1)) % 17).padStart(2, "0")}`,
      ),
    ).toBe(true);
    // To-many fields are batched per level too: 17 pools, 600 positions, their pools, each pool's first position.
    const deep = await gql(
      `{ pools(limit: 17) { items { id positions(limit: 1000, orderBy: liquidity) { items { liquidity poolInfo { positions(limit: 2, orderBy: liquidity, orderDirection: desc) { items { owner } pageInfo { hasNextPage } } } } } } } }`,
    );
    expect(deep.errors).toBeUndefined();
    const check = new pg.Pool({ connectionString: url, max: 1 });
    for (const pool of deep.data.pools.items) {
      const all = (
        await check.query(
          `SELECT owner, liquidity::text AS l FROM ${schema}.positions p WHERE pool = $1 ORDER BY p.liquidity, owner`,
          [pool.id],
        )
      ).rows;
      expect(pool.positions.items.map((x: any) => x.liquidity)).toEqual(all.map((r) => r.l));
      const top = [...all].sort(
        (a, b) => Number(b.l) - Number(a.l) || (a.owner < b.owner ? 1 : -1),
      );
      for (const x of pool.positions.items) {
        expect(x.poolInfo.positions.items).toEqual(
          top.slice(0, 2).map((r) => ({ owner: r.owner })),
        );
        expect(x.poolInfo.positions.pageInfo.hasNextPage).toBe(all.length > 2);
      }
    }
    await check.end();

    // 501 separate lookups, which can't be batched, are refused before any runs (the statement budget stays behind it).
    const many = await gql(
      `{ ${Array.from({ length: 501 }, (_, i) => `a${i}: pool(id: "p01") { id }`).join(" ")} }`,
    );
    expect(many.errors?.[0]?.message).toMatch(/Token limit of 1000 exceeded/);
  },
);
