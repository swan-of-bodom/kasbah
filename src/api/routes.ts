import type { IncomingMessage } from "node:http";
import type { Relations } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgTable } from "drizzle-orm/pg-core";
import { ConfigError } from "../config/errors.ts";
import { QueryError } from "./reader.ts";

export type Tables = Record<string, PgTable | Relations>;

export type RouteContext<T extends Tables = Tables> = {
  /** Read-only, on the app's schema, with the API's statement timeout; relational queries through `db.query`. */
  db: NodePgDatabase<T>;
  /** `:name` segments of the path. */
  params: Record<string, string>;
  query: URLSearchParams;
  /** `POST`: the JSON body, `undefined` when empty. */
  body: unknown;
  request: IncomingMessage;
};

/** Returns what is sent as JSON (bigints as strings), or a `Response` sent as is. */
export type RouteHandler<T extends Tables = Tables> = (c: RouteContext<T>) => unknown;

export type Route = { method: "GET" | "POST"; path: string; handler: RouteHandler<never> };

/** Thrown from a route: the client gets `status` and `{ error: message }`. */
export class HttpError extends QueryError {
  constructor(status: number, message: string) {
    super(message, status);
  }
}

export const BUILT_IN = ["/", "/sql", "/graphql", "/live", "/status", "/health", "/ready"];

/** Compiles `path` (`/pools/:key`) into a matcher returning its params, or `undefined` when it doesn't match. */
export function matcher(path: string): (pathname: string) => Record<string, string> | undefined {
  if (!path.startsWith("/")) throw new ConfigError(`route ${path}: a path starts with /`);
  if (BUILT_IN.includes(path)) throw new ConfigError(`route ${path}: kasbah serves it`);
  const parts = path.split("/").slice(1);
  return (pathname) => {
    const got = pathname.split("/").slice(1);
    if (got.length !== parts.length) return undefined;
    const params: Record<string, string> = {};
    for (let i = 0; i < parts.length; i++) {
      if (parts[i]!.startsWith(":")) {
        if (got[i] === "") return undefined;
        try {
          params[parts[i]!.slice(1)] = decodeURIComponent(got[i]!);
        } catch {
          throw new QueryError(`bad escape in ${pathname}`);
        }
      } else if (parts[i] !== got[i]) return undefined;
    }
    return params;
  };
}
