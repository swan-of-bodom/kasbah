import { integer, jsonb, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { Api } from "../src/api/server.ts";
import { createTableSql, tableInfo } from "../src/db/table.ts";
import { bignum } from "../src/schema.ts";

const url = process.env.DATABASE_URL;
const schema = "kasbah_test_api";

const pools = pgTable("pools", {
  id: text().primaryKey(),
  swaps: integer().notNull(),
  volume: bignum().notNull(),
  note: text(),
  extra: jsonb(),
});
const positions = pgTable("positions", { owner: text().notNull(), pool: text().notNull(), liquidity: bignum().notNull() }, (t) => [
  primaryKey({ columns: [t.owner, t.pool] }),
]);

let api: Api;
let base: string;
const rows = Array.from({ length: 17 }, (_, i) => ({ id: `p${String(i).padStart(2, "0")}`, swaps: (i * 7) % 5, volume: 10n ** 40n + BigInt(i), note: i % 3 === 0 ? null : `n${i}` }));

beforeAll(async () => {
  if (url === undefined) return;
  const owner = new pg.Pool({ connectionString: url, max: 1 });
  await owner.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
  const c = await owner.connect();
  await c.query(`SET search_path TO ${schema}`);
  for (const t of [pools, positions]) await c.query(createTableSql(tableInfo(t)));
  await c.query(`CREATE TABLE _kasbah_meta (key text PRIMARY KEY, value jsonb NOT NULL); INSERT INTO _kasbah_meta VALUES ('checkpoint', '42'), ('phase', '"live"')`);
  await c.query(`CREATE TABLE _kasbah_journal (block integer)`);
  for (const r of rows) await c.query(`INSERT INTO pools VALUES ($1, $2, $3, $4, $5)`, [r.id, r.swaps, r.volume.toString(), r.note, { i: r.id }]);
  await c.query(`INSERT INTO positions VALUES ('0xa', 'p01', 5), ('0xa', 'p02', 6), ('0xb', 'p01', 7)`);
  c.release();
  await owner.end();
  api = await Api.start({ database: url, schema, tables: { pools, positions }, port: 0, timeoutMs: 300, maxRows: 10 });
  base = `http://127.0.0.1:${api.port}`;
});

afterAll(async () => {
  if (url === undefined) return;
  await api.close();
  const owner = new pg.Pool({ connectionString: url, max: 1 });
  await owner.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await owner.end();
});

const post = async (path: string, body: unknown) => {
  const r = await fetch(base + path, { method: "POST", body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};
const gql = async (query: string, variables?: Record<string, unknown>) => (await post("/graphql", { query, variables })).body;

test.skipIf(url === undefined)("SQL: reads with parameters, numbers past 2^53 as strings", async () => {
  const r = await post("/sql", { sql: "select id, volume from pools where swaps = $1 order by id limit 2;", params: [0] });
  expect(r).toEqual({ status: 200, body: { columns: ["id", "volume"], rows: [["p00", (10n ** 40n).toString()], ["p05", (10n ** 40n + 5n).toString()]] } });
  expect((await fetch(`${base}/status`)).ok).toBe(true);
  expect(await (await fetch(`${base}/status`)).json()).toEqual({ checkpoint: 42, phase: "live" });
});

test.skipIf(url === undefined).each([
  ["insert into pools (id, swaps, volume) values ('x', 1, 1)", /syntax error/],
  ["select 1; delete from pools", /syntax error/],
  ["select 1) as a; delete from pools; select (1", /cannot insert multiple commands|syntax error/],
  ["set statement_timeout = 0", /syntax error/],
  ["select * from _kasbah_journal", /permission denied/],
  ["select pg_read_file('/etc/passwd')", /permission denied/],
  ["select pg_sleep(2)", /cancelled after 300 ms/],
  ["select * from pools", /more than 10 rows/],
  ["", /empty query/],
])("SQL: refuses %s", async (sql, message) => {
  const r = await post("/sql", { sql });
  expect(r.status).toBe(400);
  expect(r.body.error).toMatch(message);
});

test.skipIf(url === undefined)("SQL: settings made by one query don't reach the next", async () => {
  // Every pooled connection gets the attempt.
  for (let i = 0; i < 10; i++) expect((await post("/sql", { sql: "select set_config('statement_timeout', '0', false)" })).status).toBe(200);
  expect((await post("/sql", { sql: "select pg_sleep(1)" })).body.error).toMatch(/cancelled/);
  expect((await post("/sql", { sql: "select current_setting('transaction_read_only')" })).body.rows).toEqual([["on"]]);
});

test.skipIf(url === undefined)("GraphQL: one row by primary key, composite keys too", async () => {
  expect(await gql(`{ pool(id: "p04") { id swaps volume note extra } }`)).toEqual({
    data: { pool: { id: "p04", swaps: 3, volume: (10n ** 40n + 4n).toString(), note: "n4", extra: { i: "p04" } } },
  });
  expect(await gql(`{ pool(id: "nope") { id } }`)).toEqual({ data: { pool: null } });
  expect(await gql(`{ position(owner: "0xa", pool: "p02") { liquidity } }`)).toEqual({ data: { position: { liquidity: "6" } } });
});

test.skipIf(url === undefined)("GraphQL: filters", async () => {
  const ids = async (where: string) => (await gql(`{ pools(where: ${where}, limit: 100) { items { id } } }`)).data.pools.items.map((i: { id: string }) => i.id);
  const all = rows.map((r) => r.id);
  expect(await ids(`{ swaps: 0 }`)).toEqual(rows.filter((r) => r.swaps === 0).map((r) => r.id));
  expect(await ids(`{ volume_gt: "${10n ** 40n + 14n}" }`)).toEqual(["p15", "p16"]);
  expect(await ids(`{ id_in: ["p01", "p03", "zz"] }`)).toEqual(["p01", "p03"]);
  expect(await ids(`{ note: null }`)).toEqual(rows.filter((r) => r.note === null).map((r) => r.id));
  expect(await ids(`{ note_not: null, swaps_lte: 1 }`)).toEqual(rows.filter((r) => r.note !== null && r.swaps <= 1).map((r) => r.id));
  expect(await ids(`{ OR: [{ id: "p02" }, { id_not_in: ${JSON.stringify(all.slice(1))} }] }`)).toEqual(["p00", "p02"]);
});

test.skipIf(url === undefined).each(["asc", "desc"])("GraphQL: paging by a non-unique column, %s, visits every row once", async (dir) => {
  const seen: string[] = [];
  let after: string | null = null;
  for (let i = 0; i < 10; i++) {
    const r: any = await gql(`query($after: String) { pools(orderBy: swaps, orderDirection: ${dir}, limit: 3, after: $after) { items { id swaps } pageInfo { hasNextPage endCursor } } }`, { after });
    if (r.errors) throw new Error(JSON.stringify(r.errors));
    seen.push(...r.data.pools.items.map((p: { id: string }) => p.id));
    if (!r.data.pools.pageInfo.hasNextPage) break;
    after = r.data.pools.pageInfo.endCursor;
  }
  const sign = dir === "asc" ? 1 : -1;
  const expected = [...rows].sort((a, b) => sign * (a.swaps - b.swaps || a.id.localeCompare(b.id))).map((r) => r.id);
  expect(seen).toEqual(expected);
});

test.skipIf(url === undefined)("GraphQL: bad input is a client error, not an internal one", async () => {
  expect((await gql(`{ pools(after: "garbage") { items { id } } }`)).errors[0].message).toBe("invalid cursor");
  expect((await gql(`{ pools(limit: 5000) { items { id } } }`)).errors[0].message).toMatch(/limit must be/);
  expect((await gql(`{ pools(where: { volume: "1.5" }) { items { id } } }`)).errors[0].message).toMatch(/decimal string/);
  expect((await gql(`{ nothing }`)).errors[0].message).toMatch(/Cannot query field/);
  expect((await gql(`{ _meta { checkpoint phase } }`)).data._meta).toEqual({ checkpoint: 42, phase: "live" });
});
