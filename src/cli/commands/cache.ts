import pg from "pg";
import { ConfigError } from "../../config/errors.ts";
import { EventCache } from "../../db/cache.ts";

/** `kasbah cache clear`: empties the event caches; `kasbah list` shows them with their sizes. */
export async function cache(
  command: string | undefined,
  o: { database?: string; events?: boolean; calls?: boolean; chain?: string },
) {
  if (command !== "clear")
    throw new ConfigError(
      "usage: kasbah cache clear [--events] [--calls] [--chain <id>] (kasbah list shows the caches)",
    );
  const database = o.database ?? process.env.DATABASE_URL;
  if (database === undefined) throw new ConfigError("set DATABASE_URL or pass --database");
  const pool = new pg.Pool({ connectionString: database, max: 1 });
  try {
    const what =
      o.events || o.calls ? { events: o.events, calls: o.calls } : { events: true, calls: true };
    await EventCache.clear(pool, what, o.chain);
    console.log(
      `cleared ${[what.events && "events", what.calls && "calls"].filter(Boolean).join(" and ")}${o.chain === undefined ? "" : ` for ${o.chain}`}`,
    );
  } finally {
    await pool.end();
  }
}
