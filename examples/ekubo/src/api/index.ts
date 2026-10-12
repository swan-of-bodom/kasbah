import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { HttpError } from "../../../../src/index.ts";
import app from "../../kasbah.config.ts";
import { candles, history, pools } from "../../kasbah.schema.ts";
import { INTERVALS } from "../index.ts";

/** The most swapped pools in the day after `?since=` (unix seconds; default: the last day), with their latest state. */
app.get("/pools/top", async ({ db, query }) => {
  const limit = Math.min(Number(query.get("limit") ?? 20) || 20, 100);
  const since = Number(query.get("since") ?? Math.floor(Date.now() / 1000) - 86_400);
  if (!Number.isInteger(since)) throw new HttpError(400, "since is unix seconds");
  const swaps24h = sql<number>`sum(${candles.swaps})::int`;
  return db
    .select({ pool: pools, swaps24h })
    .from(candles)
    .innerJoin(pools, eq(pools.id, candles.pool))
    .where(and(eq(candles.interval, 3_600), gte(candles.time, since), lt(candles.time, since + 86_400)))
    .groupBy(pools.id)
    .orderBy(desc(swaps24h))
    .limit(limit);
});

/** `?interval=3600|86400&limit=n`: the newest `n` candles, oldest first. */
app.get("/pools/:id/candles", async ({ db, params, query }) => {
  const interval = Number(query.get("interval") ?? 3_600);
  if (!INTERVALS.includes(interval)) throw new HttpError(400, `interval is one of ${INTERVALS.join(", ")}`);
  const limit = Math.min(Number(query.get("limit") ?? 200) || 200, 1_000);
  const rows = await db.select().from(candles).where(and(eq(candles.pool, params.id!), eq(candles.interval, interval))).orderBy(desc(candles.time)).limit(limit);
  if (rows.length === 0 && (await db.select({ id: pools.id }).from(pools).where(eq(pools.id, params.id!))).length === 0) throw new HttpError(404, `no pool ${params.id}`);
  return rows.reverse();
});

app.get("/history", async ({ db, query }) => db.select().from(history).orderBy(desc(history.block)).limit(Math.min(Number(query.get("limit") ?? 100) || 100, 1_000)));
