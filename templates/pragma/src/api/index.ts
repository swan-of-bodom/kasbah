import { Hono } from "hono";
import { desc, replaceBigInts } from "kasbah";
import { db, graphql } from "kasbah/api";
import * as schema from "../../kasbah.schema.ts";
import { price } from "../../kasbah.schema.ts";

const app = new Hono();

app.use("/graphql", graphql({ db, schema }));

/** Each pair's latest price. */
app.get("/prices/latest", async (c) => {
  const rows = await db
    .selectDistinctOn([price.pair])
    .from(price)
    .orderBy(price.pair, desc(price.block));
  return c.json(replaceBigInts(rows, String));
});

export default app;
