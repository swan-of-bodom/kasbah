import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { desc, eq, felt, replaceBigInts } from "kasbah";
import { db, graphql } from "kasbah/api";
import * as schema from "../../kasbah.schema.ts";
import { account } from "../../kasbah.schema.ts";

const app = new Hono();

app.use("/graphql", graphql({ db, schema }));

/** The largest holders, `?limit=` (default 20, at most 100). */
app.get("/holders", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 20) || 20, 100);
  const rows = await db.select().from(account).orderBy(desc(account.balance)).limit(limit);
  return c.json(replaceBigInts(rows, String));
});

/** One account's balance, 0 for an address that never held LORDS. */
app.get("/balance/:address", async (c) => {
  const given = c.req.param("address");
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(given))
    throw new HTTPException(400, { message: "the address is 0x and up to 64 hex digits" });
  // Addresses are stored as kasbah hands them out: 0x and 64 lowercase digits.
  const address = felt(given);
  const [row] = await db.select().from(account).where(eq(account.address, address));
  return c.json({ address, balance: String(row?.balance ?? 0n) });
});

export default app;
