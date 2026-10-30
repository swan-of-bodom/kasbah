import { eq, relations, sql } from "drizzle-orm";
import { integer, jsonb, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { getIntrospectionQuery } from "graphql";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { HttpError, type Route } from "../../src/api/routes.ts";
import { Api } from "../../src/api/server.ts";
import { bignum } from "../../src/config/schema.ts";
import { createTableSql, tableInfo } from "../../src/db/table.ts";

const url = process.env.DATABASE_URL;
const schema = "kasbah_test_api";

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
  type Db = import("drizzle-orm/node-postgres").NodePgDatabase<typeof tables>;
  const routes: Route[] = [
    {
      method: "GET",
      path: "/pools/:id",
      handler: (async ({
        db,
        params,
        query,
      }: {
        db: Db;
        params: Record<string, string>;
        query: URLSearchParams;
      }) => {
        const pool = await db.query.pools.findFirst({
          where: eq(pools.id, params.id!),
          with: { positions: true },
        });
        if (pool === undefined) throw new HttpError(404, `no pool ${params.id}`);
        return {
          id: pool.id,
          volume: pool.volume,
          positions: pool.positions.length,
          q: query.get("q"),
        };
      }) as never,
    },
    {
      method: "POST",
      path: "/echo",
      handler: (({ body }: { body: unknown }) =>
        new Response(JSON.stringify(body), {
          status: 201,
          headers: { "cache-control": "max-age=5", "content-type": "application/json" },
        })) as never,
    },
    {
      method: "GET",
      path: "/write",
      handler: (async ({ db }: { db: Db }) => db.execute(sql`delete from pools`)) as never,
    },
    {
      method: "GET",
      path: "/slow",
      handler: (async ({ db }: { db: Db }) => db.execute(sql`select pg_sleep(2)`)) as never,
    },
  ];
  api = await Api.start({
    database: url,
    schema,
    tables,
    port: 0,
    timeoutMs: 300,
    maxRows: 10,
    routes,
  });
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
const gql = async (query: string, variables?: Record<string, unknown>) =>
  (await post("/graphql", { query, variables })).body;

test.skipIf(url === undefined)(
  "SQL: reads with parameters, numbers past 2^53 as strings",
  async () => {
    const r = await post("/sql", {
      sql: "select id, volume from pools where swaps = $1 order by id limit 2;",
      params: [0],
    });
    expect(r).toEqual({
      status: 200,
      body: {
        columns: ["id", "volume"],
        rows: [
          ["p00", (10n ** 40n).toString()],
          ["p05", (10n ** 40n + 5n).toString()],
        ],
      },
    });
    expect((await fetch(`${base}/status`)).ok).toBe(true);
    expect(await (await fetch(`${base}/status`)).json()).toEqual({ checkpoint: 42, phase: "live" });
  },
);

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
  for (let i = 0; i < 10; i++)
    expect(
      (await post("/sql", { sql: "select set_config('statement_timeout', '0', false)" })).status,
    ).toBe(200);
  expect((await post("/sql", { sql: "select pg_sleep(1)" })).body.error).toMatch(/cancelled/);
  expect(
    (await post("/sql", { sql: "select current_setting('transaction_read_only')" })).body.rows,
  ).toEqual([["on"]]);
});

test.skipIf(url === undefined)(
  "two API processes on one schema: the first still opens new connections",
  async () => {
    const second = await Api.start({ database: url!, schema, tables: { pools }, port: 0 });
    try {
      // More queries at once than the first has connections open, so it must open new ones.
      const all = await Promise.all(
        Array.from({ length: 12 }, () => post("/sql", { sql: "select count(*)::int from pools" })),
      );
      for (const r of all) expect(r.status).toBe(200);
    } finally {
      await second.close();
    }
  },
);

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

/** Reads server-sent events from `/live` until `count` arrive. */
async function live(query: string, count: number, during: () => Promise<void>) {
  const controller = new AbortController();
  const r = await fetch(`${base}/live?${query}`, { signal: controller.signal });
  expect(r.status).toBe(200);
  const reader = r.body!.getReader();
  const events: { event: string; data: any }[] = [];
  let buffer = "";
  const timer = setTimeout(() => controller.abort(), 4_000);
  void during();
  while (events.length < count) {
    const { value, done } = await reader
      .read()
      .catch(() => ({ value: undefined, done: true as const }));
    if (done) break;
    buffer += new TextDecoder().decode(value);
    let at: number;
    while ((at = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event !== undefined) events.push({ event, data: JSON.parse(data!) });
    }
  }
  clearTimeout(timer);
  controller.abort();
  return events;
}

/** A commit the way the indexer makes one: change rows, notify in the same transaction. */
async function commit(sql: string, checkpoint: number) {
  const owner = new pg.Pool({ connectionString: url, max: 1 });
  const c = await owner.connect();
  await c.query(`BEGIN; SET LOCAL search_path TO ${schema}`);
  await c.query(sql);
  await c.query(`SELECT pg_notify($1, $2)`, [`kasbah_${schema}`, JSON.stringify({ checkpoint })]);
  await c.query("COMMIT");
  c.release();
  await owner.end();
}

test.skipIf(url === undefined)(
  "live SQL: the result now, then again only when a commit changed it",
  async () => {
    const events = await live(
      `sql=${encodeURIComponent("select id, swaps from pools where id = $1")}&params=${encodeURIComponent('["p01"]')}`,
      4,
      async () => {
        await commit(`UPDATE pools SET note = 'other column' WHERE id = 'p01'`, 43);
        await commit(`UPDATE pools SET swaps = 100 WHERE id = 'p01'`, 44);
      },
    );
    expect(events).toEqual([
      { event: "result", data: { columns: ["id", "swaps"], rows: [["p01", 2]] } },
      { event: "checkpoint", data: { checkpoint: 43 } },
      { event: "checkpoint", data: { checkpoint: 44 } },
      { event: "result", data: { columns: ["id", "swaps"], rows: [["p01", 100]] } },
    ]);
  },
);

test.skipIf(url === undefined)("live GraphQL, and a bad live query is a plain 400", async () => {
  const events = await live(
    `query=${encodeURIComponent('{ pool(id: "p02") { swaps } }')}`,
    3,
    async () => {
      await commit(`UPDATE pools SET swaps = 7 WHERE id = 'p02'`, 45);
    },
  );
  expect(events.filter((e) => e.event === "result").map((e) => e.data)).toEqual([
    { data: { pool: { swaps: 4 } } },
    { data: { pool: { swaps: 7 } } },
  ]);
  const bad = await fetch(`${base}/live?sql=${encodeURIComponent("delete from pools")}`);
  expect(bad.status).toBe(400);
  expect((await fetch(`${base}/live?sql=x&params=nope`)).status).toBe(400);
});

test.skipIf(url === undefined)("a reader can't notify live clients itself", async () => {
  // The spoofed notification would arrive before the real one.
  const events = await live("", 1, async () => {
    await post("/sql", {
      sql: `select pg_notify('kasbah_${schema}', '{"checkpoint": 999}')`,
    });
    await commit(`SELECT 1`, 46);
  });
  expect(events).toEqual([{ event: "checkpoint", data: { checkpoint: 46 } }]);
});

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
  "GraphQL relations: to-one and to-many are batched per level, and a request has a statement budget",
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
    expect(many.errors?.[0]?.message).toMatch(/more than 1000 tokens/);
  },
);

test.skipIf(url === undefined)(
  "GET /graphql: GraphiQL for a browser, ?query= for anything else",
  async () => {
    const page = await fetch(`${base}/graphql`, {
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("GraphiQL.createFetcher");
    const viaGet = (await (
      await fetch(
        `${base}/graphql?query=${encodeURIComponent(`query ($id: String!) { pool(id: $id) { id } }`)}&variables=${encodeURIComponent(JSON.stringify({ id: "p01" }))}`,
      )
    ).json()) as any;
    expect(viaGet).toEqual(
      await gql(`query ($id: String!) { pool(id: $id) { id } }`, { id: "p01" }),
    );
    expect(viaGet.data.pool.id).toBe("p01");
    const bare = await fetch(`${base}/graphql`);
    expect(bare.status).toBe(400);
    expect(((await bare.json()) as any).error).toContain("?query=");
    expect(((await (await fetch(`${base}/`)).json()) as any).endpoints).toEqual(
      expect.arrayContaining(["GET /health", "GET /ready", "GET /pools/:id", "POST /echo"]),
    );
  },
);

test.skipIf(url === undefined)(
  "routes: typed read-only db, path params, errors with a status, a Response as is",
  async () => {
    expect(await (await fetch(`${base}/pools/p01?q=x`)).json()).toEqual({
      id: "p01",
      volume: (10n ** 40n + 1n).toString(),
      positions: Number(
        (await post("/sql", { sql: "select count(*)::int from positions where pool = 'p01'" })).body
          .rows[0][0],
      ),
      q: "x",
    });
    expect([
      (await fetch(`${base}/pools/nope`)).status,
      await (await fetch(`${base}/pools/nope`)).json(),
    ]).toEqual([404, { error: "no pool nope" }]);
    const echo = await fetch(`${base}/echo`, { method: "POST", body: JSON.stringify({ a: 1 }) });
    expect([echo.status, echo.headers.get("cache-control"), await echo.json()]).toEqual([
      201,
      "max-age=5",
      { a: 1 },
    ]);
    expect((await fetch(`${base}/echo`)).status).toBe(404);
    const write = await fetch(`${base}/write`);
    expect([write.status, (await write.json()).error]).toEqual([
      400,
      expect.stringMatching(/read-only transaction/),
    ]);
    expect((await fetch(`${base}/slow`)).status).toBe(400);
    expect((await post("/sql", { sql: "select count(*)::int as n from pools" })).body.rows).toEqual(
      [[17]],
    );
  },
);

test.skipIf(url === undefined)(
  "routes: a built-in path or a duplicate is refused at start",
  async () => {
    const start = (routes: Route[]) =>
      Api.start({ database: url!, schema, tables: { pools }, port: 0, routes });
    await expect(start([{ method: "GET", path: "/sql", handler: () => 1 }])).rejects.toThrow(
      /kasbah serves it/,
    );
    await expect(
      start([
        { method: "GET", path: "/a", handler: () => 1 },
        { method: "GET", path: "/a", handler: () => 2 },
      ]),
    ).rejects.toThrow(/defined twice/);
  },
);

test.skipIf(url === undefined)(
  "GraphQL limits: tokens, depth and aliases; GraphiQL's introspection fits",
  async () => {
    expect((await gql(getIntrospectionQuery())).errors).toBeUndefined();
    let deep = "id";
    for (let i = 0; i < 7; i++) deep = `positions { items { poolInfo { ${deep} } } }`;
    expect((await gql(`{ pool(id: "p01") { ${deep} } }`)).errors[0].message).toBe(
      "query deeper than 20 levels",
    );
    const aliases = Array.from({ length: 31 }, (_, i) => `a${i}: pool(id: "p01") { id }`).join(" ");
    expect((await gql(`{ ${aliases} }`)).errors[0].message).toBe("more than 30 aliases");
    expect((await gql(`{ pool(id: "p01") { ${"id ".repeat(1_000)} } }`)).errors[0].message).toMatch(
      /more than 1000 tokens/,
    );
    const looped = await gql(
      `{ pool(id: "p01") { ...A } } fragment A on Pool { positions { items { poolInfo { ...A } } } }`,
    );
    expect(looped.errors[0].message).toMatch(/Cannot spread fragment "A" within itself/);
  },
);

test.skipIf(url === undefined)(
  "health: up while the database answers; ready once live",
  async () => {
    expect([
      (await fetch(`${base}/health`)).status,
      await (await fetch(`${base}/health`)).json(),
    ]).toEqual([200, { ok: true }]);
    expect((await fetch(`${base}/ready`)).status).toBe(200);
    const owner = new pg.Pool({ connectionString: url, max: 1 });
    await owner.query(`UPDATE ${schema}._kasbah_meta SET value = '"backfill"' WHERE key = 'phase'`);
    expect([
      (await fetch(`${base}/ready`)).status,
      (await (await fetch(`${base}/ready`)).json()).phase,
    ]).toEqual([503, "backfill"]);
    await owner.query(`UPDATE ${schema}._kasbah_meta SET value = '"live"' WHERE key = 'phase'`);
    await owner.end();
  },
);
