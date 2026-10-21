import pg from "pg";
import { ConfigError } from "../../config/errors.ts";
import { EventCache } from "../../db/cache.ts";

export async function cache(
  command: string | undefined,
  o: { database?: string; events?: boolean; calls?: boolean; chain?: string },
) {
  if (command !== "info" && command !== "clear")
    throw new ConfigError(
      "usage: kasbah cache info [--chain <id>] | cache clear [--events] [--calls] [--chain <id>]",
    );
  const database = o.database ?? process.env.DATABASE_URL;
  if (database === undefined) throw new ConfigError("set DATABASE_URL or pass --database");
  const pool = new pg.Pool({ connectionString: database, max: 1 });
  try {
    if (command === "info") {
      const info = await EventCache.info(pool, o.chain);
      if (info.length === 0) console.log("no caches");
      for (const c of info)
        console.log(
          `${c.schema}: ${c.events} events, ${c.transactions} transactions, ${c.calls} calls, ${c.headers} headers, ${(c.bytes / 2 ** 20).toFixed(1)} MB`,
        );
    } else {
      const what =
        o.events || o.calls ? { events: o.events, calls: o.calls } : { events: true, calls: true };
      await EventCache.clear(pool, what, o.chain);
      console.log(
        `cleared ${[what.events && "events", what.calls && "calls"].filter(Boolean).join(" and ")}${o.chain === undefined ? "" : ` for ${o.chain}`}`,
      );
    }
  } finally {
    await pool.end();
  }
}
