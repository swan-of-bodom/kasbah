import pg from "pg";
import { ConfigError } from "../../config/errors.ts";
import { dropStopped, listSchemas } from "../../indexer/schemas.ts";
import { Prompt } from "../ui/prompt.ts";
import { size } from "../ui/table.ts";
import { where } from "./list.ts";

/**
 * `kasbah prune`: drops every app schema in the database that no indexer is running, after listing them and asking
 * (or with `--yes`). The event caches stay: they hold what the RPC served, which any app re-indexes from.
 */
export async function prune(o: { database?: string; yes?: boolean }) {
  const database = o.database ?? process.env.DATABASE_URL;
  if (database === undefined)
    throw new ConfigError(
      "prune drops schemas in DATABASE_URL: set it or pass --database (a dev container: kasbah clean in its app)",
    );
  const pool = new pg.Pool({ connectionString: database, max: 1 });
  try {
    const stopped = (await listSchemas(pool)).schemas.filter((s) => !s.running);
    if (stopped.length === 0) return void console.log(`nothing to prune in ${where(database)}`);
    console.log(`stopped schemas in ${where(database)}:`);
    for (const s of stopped) console.log(`  ${s.schema}  ${size(s.bytes)}`);
    const total = size(stopped.reduce((n, s) => n + s.bytes, 0));
    if (!o.yes) {
      if (!process.stdin.isTTY)
        throw new ConfigError("prune drops these schemas and their data: pass --yes to confirm");
      const ok = await new Prompt().confirm(
        `Drop ${stopped.length === 1 ? "it" : `these ${stopped.length}`} (${total})?`,
        false,
      );
      if (!ok) return void console.log("kept");
    }
    const dropped = await dropStopped(
      pool,
      stopped.map((s) => s.schema),
    );
    const skipped = stopped.length - dropped.length;
    console.log(
      `dropped ${dropped.length} ${dropped.length === 1 ? "schema" : "schemas"}${skipped === 0 ? "" : `; ${skipped} started meanwhile and stayed`}`,
    );
  } finally {
    await pool.end();
  }
}
