import { Hono } from "hono";
import { desc, replaceBigInts } from "kasbah";
import { db, graphql } from "kasbah/api";
import * as schema from "../../kasbah.schema.ts";
import { pool } from "../../kasbah.schema.ts";

const app = new Hono();

app.use("/graphql", graphql({ db, schema }));

/** The most swapped pools, `?limit=` (default 20, at most 100). */
app.get("/pools/top", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 20) || 20, 100);
  const rows = await db.select().from(pool).orderBy(desc(pool.swapCount)).limit(limit);
  return c.json(replaceBigInts(rows, String));
});

export default app;
