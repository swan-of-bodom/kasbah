import { createServer } from "node:http";
import { count, eq, sql } from "drizzle-orm";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { db } from "../../src/api/index.ts";
import { Api } from "../../src/api/server.ts";
import { bignum } from "../../src/config/schema.ts";
import { createTableSql, tableInfo } from "../../src/db/table.ts";
import { replaceBigInts } from "../../src/utils/replace-bigints.ts";

const url = process.env.DATABASE_URL;
const schema = "kasbah_test_server";
const other = "kasbah_test_server_b";

const pools = pgTable("pools", {
  id: text().primaryKey(),
  swaps: integer().notNull(),
  volume: bignum().notNull(),
});

const app = new Hono()
  .get("/pools/:id", async (c) => {
    const [pool] = await db
      .select()
      .from(pools)
      .where(eq(pools.id, c.req.param("id")));
    if (pool === undefined)
      throw new HTTPException(404, { message: `no pool ${c.req.param("id")}` });
    return c.json(replaceBigInts({ ...pool, q: c.req.query("q") }, String));
  })
  .get("/count", async (c) => c.json((await db.select({ n: count() }).from(pools))[0]))
  .post("/echo", async (c) =>
    c.body(await c.req.text(), 201, {
      "cache-control": "max-age=5",
      "content-type": "application/json",
    }),
  )
  .get("/write", async (c) => c.json(await db.execute(sql`delete from pools`)))
  .get("/slow", async (c) => c.json(await db.execute(sql`select pg_sleep(2)`)));

let api: Api;
let base: string;

async function seed(name: string, rows: number) {
  const owner = new pg.Pool({ connectionString: url, max: 1, options: `-c search_path=${name}` });
  try {
    await owner.query(`DROP SCHEMA IF EXISTS ${name} CASCADE; CREATE SCHEMA ${name}`);
    await owner.query(createTableSql(tableInfo(pools)));
    await owner.query(
      `CREATE TABLE _kasbah_meta (key text PRIMARY KEY, value jsonb NOT NULL);
       INSERT INTO _kasbah_meta VALUES ('checkpoint', '42'), ('checkpointTime', '1700000000'), ('phase', '"live"'),
         ('chain', '"SN_MAIN"')`,
    );
    for (let i = 0; i < rows; i++)
      await owner.query(`INSERT INTO pools VALUES ($1, $2, $3)`, [
        `p${i}`,
        i,
        (10n ** 40n + BigInt(i)).toString(),
      ]);
  } finally {
    await owner.end();
  }
}

const owner = async (query: string) => {
  const p = new pg.Pool({ connectionString: url, max: 1 });
  try {
    return (await p.query(query)).rows;
  } finally {
    await p.end();
  }
};

beforeAll(async () => {
  if (url === undefined) return;
  await seed(schema, 3);
  api = await Api.start({ database: url, schema, tables: { pools }, port: 0, app, timeoutMs: 300 });
  base = `http://127.0.0.1:${api.port}`;
});

afterAll(async () => {
  if (url === undefined) return;
  await api.close();
  await owner(`DROP SCHEMA IF EXISTS ${schema} CASCADE; DROP SCHEMA IF EXISTS ${other} CASCADE`);
});

const get = async (path: string) => {
  const r = await fetch(base + path);
  return [r.status, await r.text()] as const;
};

test.skipIf(url === undefined)(
  "health, readiness, status and metrics are served before the app's routes",
  async () => {
    expect(await get("/health")).toEqual([200, ""]);
    expect(await get("/ready")).toEqual([200, ""]);
    expect(JSON.parse((await get("/status"))[1])).toEqual({
      SN_MAIN: { id: "SN_MAIN", block: { number: 42, timestamp: 1700000000 } },
    });
    expect((await get("/metrics"))[1]).toMatch(/^kasbah_checkpoint 42$/m);
    expect((await fetch(`${base}/health`)).headers.get("access-control-allow-origin")).toBe("*");
    await owner(`UPDATE ${schema}._kasbah_meta SET value = '"backfill"' WHERE key = 'phase'`);
    try {
      expect(await get("/ready")).toEqual([503, "Historical indexing is not complete."]);
    } finally {
      await owner(`UPDATE ${schema}._kasbah_meta SET value = '"live"' WHERE key = 'phase'`);
    }
    expect((await get("/nope"))[0]).toBe(404);
  },
);

test.skipIf(url === undefined)(
  "the app's routes get the read-only db, path and query params, HTTP errors with their status, and a Response as is",
  async () => {
    expect(JSON.parse((await get("/pools/p1?q=x"))[1])).toEqual({
      id: "p1",
      swaps: 1,
      volume: (10n ** 40n + 1n).toString(),
      q: "x",
    });
    expect(await get("/pools/nope")).toEqual([404, "no pool nope"]);
    const echo = await fetch(`${base}/echo`, { method: "POST", body: JSON.stringify({ a: 1 }) });
    expect([echo.status, echo.headers.get("cache-control"), await echo.json()]).toEqual([
      201,
      "max-age=5",
      { a: 1 },
    ]);
  },
);

test.skipIf(url === undefined)(
  "a route can't write or run past the timeout, and its error names the route",
  async () => {
    const [status, text] = await get("/write");
    expect(status).toBe(500);
    expect(text).toMatch(/read-only transaction/);
    expect(text).toMatch(/while handling a 'GET' request to the route '\/write'/);
    expect(await get("/slow")).toEqual([500, expect.stringMatching(/statement timeout/)]);
    expect(JSON.parse((await get("/count"))[1])).toEqual({ n: 3 });
  },
);

test.skipIf(url === undefined)("db outside a request says where it works", () => {
  expect(() => db.select()).toThrow(/works only in the API's code/);
});

test.skipIf(url === undefined)(
  "two APIs in one process each answer from their own database",
  async () => {
    await seed(other, 5);
    const second = await Api.start({
      database: url!,
      schema: other,
      tables: { pools },
      port: 0,
      app,
    });
    try {
      const counts = await Promise.all(
        Array.from({ length: 20 }, async (_, i) => {
          const port = i % 2 === 0 ? api.port : second.port;
          return ((await (await fetch(`http://127.0.0.1:${port}/count`)).json()) as { n: number })
            .n;
        }),
      );
      expect(counts).toEqual(Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 3 : 5)));
    } finally {
      await second.close();
    }
  },
);

test.skipIf(url === undefined)(
  "a port already in use is refused, and the connections opened for it are closed",
  async () => {
    const taken = createServer();
    await new Promise<void>((r) => taken.listen(0, "127.0.0.1", r));
    const port = (taken.address() as { port: number }).port;
    const readers = async () =>
      (
        await owner(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = '${schema}_reader'`,
        )
      )[0].n as number;
    try {
      const before = await readers();
      await expect(Api.start({ database: url!, schema, tables: { pools }, port })).rejects.toThrow(
        `port ${port} is in use`,
      );
      await expect.poll(readers).toBe(before);
    } finally {
      taken.close();
    }
  },
);
