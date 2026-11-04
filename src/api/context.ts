import { AsyncLocalStorage } from "node:async_hooks";
import type { Relations } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgTable } from "drizzle-orm/pg-core";
import { ConfigError } from "../config/errors.ts";
import type { Reader } from "./reader.ts";

export type Tables = Record<string, PgTable | Relations>;

/** The app's own endpoints: a Hono app (the default export of `src/api/index.ts`). */
export type ApiApp = { fetch: (request: Request) => Response | Promise<Response> };

/** What one running API gives the code it serves: `db` and `graphql()` find it here. */
export type ApiContext = {
  /** Read-only Drizzle on the app's schema, with the API's timeouts. */
  db: NodePgDatabase<Tables>;
  reader: Reader;
  /** The app's tables and relations, as the config has them. */
  tables: Tables;
};

/**
 * Whether errors reach the client with their message and where they were thrown: in `kasbah dev`
 * (`NODE_ENV=development`) only. Elsewhere the client gets a plain 500, and the process logs the error.
 */
export const detailedErrors = (): boolean => process.env.NODE_ENV === "development";

/** The API serving the request (or loading the app's API file), so two in one process never mix. */
export const apiContext = new AsyncLocalStorage<ApiContext>();

/** The running API, for `what`; outside one, a mistake in the app. */
export function currentApi(what: string): ApiContext {
  const c = apiContext.getStore();
  if (c === undefined)
    throw new ConfigError(
      `${what} from kasbah/api works only in the API's code (src/api), while kasbah serves it`,
    );
  return c;
}
