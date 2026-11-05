import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { currentApi, type Tables } from "./context.ts";

/**
 * The app's database, read-only, as Drizzle: in a request, the database of the API serving it. Its queries time
 * out after `API_DB.timeoutMs` (30 s).
 */
export const db: NodePgDatabase<Tables> = new Proxy({} as NodePgDatabase<Tables>, {
  get(_, key) {
    const real = currentApi("db").db;
    const value = Reflect.get(real, key, real);
    return typeof value === "function" ? value.bind(real) : value;
  },
  has: (_, key) => key in currentApi("db").db,
});
