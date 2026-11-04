import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { db, graphql } from "../../../../src/api/index.ts";
import { and, desc, eq, gte, lt, replaceBigInts, sql } from "../../../../src/index.ts";
import * as schema from "../../kasbah.schema.ts";
import { candles, history, pools } from "../../kasbah.schema.ts";
import { INTERVALS } from "../index.ts";

const app = new Hono();

app.use("/graphql", graphql({ db, schema }));

/** The most swapped pools in the day after `?since=` (unix seconds; default: the last day), with their latest state. */
app.get("/pools/top", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 20) || 20, 100);
  const since = Number(c.req.query("since") ?? Math.floor(Date.now() / 1000) - 86_400);
  if (!Number.isInteger(since)) throw new HTTPException(400, { message: "since is unix seconds" });
  const swaps24h = sql<number>`sum(${candles.swaps})::int`;
  const rows = await db
    .select({ pool: pools, swaps24h })
    .from(candles)
    .innerJoin(pools, eq(pools.id, candles.pool))
    .where(
      and(eq(candles.interval, 3_600), gte(candles.time, since), lt(candles.time, since + 86_400)),
    )
    .groupBy(pools.id)
    .orderBy(desc(swaps24h))
    .limit(limit);
  return c.json(replaceBigInts(rows, String));
});

/** `?interval=3600|86400&limit=n`: the newest `n` candles, oldest first. */
app.get("/pools/:id/candles", async (c) => {
  const id = c.req.param("id");
  const interval = Number(c.req.query("interval") ?? 3_600);
  if (!INTERVALS.includes(interval))
    throw new HTTPException(400, { message: `interval is one of ${INTERVALS.join(", ")}` });
  const limit = Math.min(Number(c.req.query("limit") ?? 200) || 200, 1_000);
  const rows = await db
    .select()
    .from(candles)
    .where(and(eq(candles.pool, id), eq(candles.interval, interval)))
    .orderBy(desc(candles.time))
    .limit(limit);
  if (
    rows.length === 0 &&
    (await db.select({ id: pools.id }).from(pools).where(eq(pools.id, id))).length === 0
  )
    throw new HTTPException(404, { message: `no pool ${id}` });
  return c.json(replaceBigInts(rows.reverse(), String));
});

app.get("/history", async (c) => {
  const rows = await db
    .select()
    .from(history)
    .orderBy(desc(history.block))
    .limit(Math.min(Number(c.req.query("limit") ?? 100) || 100, 1_000));
  return c.json(replaceBigInts(rows, String));
});

export default app;
