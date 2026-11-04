import { createHmac } from "node:crypto";
import { DrizzleQueryError } from "drizzle-orm/errors";
import pg from "pg";
import { RetryingPool } from "../db/pool.ts";
import type { TableInfo } from "../db/table.ts";
import { errorCode } from "../utils/errors.ts";
import { quote } from "../utils/quote.ts";

export type ReaderOptions = {
  /** Connection the indexer writes with; used once to set up the reader role. */
  database: string;
  schema: string;
  tables: TableInfo[];
  /** A login that may only read the app's tables. Without it, kasbah creates `<schema>_reader` (needs CREATEROLE). */
  readDatabase?: string;
  /** Per query. Default `API_TIMEOUT_MS`. */
  timeoutMs?: number;
};

/** How long one API query may run: long enough for an aggregate over a large table, short enough to free its connection. */
export const API_TIMEOUT_MS = 30_000;

/** How long an API query waits for a lock: the indexer's key and index builds lock tables, and readers don't queue behind them. */
export const API_LOCK_TIMEOUT_MS = 500;

/** Connections the API keeps to Postgres. */
const API_POOL_SIZE = 8;

/** A Postgres error the client's query caused: its message reaches the client. */
export class QueryError extends Error {}

/**
 * Postgres error classes a GraphQL client can cause with the values it sends: a value out of a type's range (22), a
 * filter too large (54), and the statement timeout. kasbah writes the SQL, so anything else is ours.
 */
const CLIENT_ERRORS = new Set(["22", "54", "57014"]);
const clientError = (e: unknown) => {
  const code = errorCode(e);
  return code !== undefined && (CLIENT_ERRORS.has(code) || CLIENT_ERRORS.has(code.slice(0, 2)));
};

/** Postgres errors a query can cause become `QueryError`s (shown to the client); the rest stay internal. */
export function asQueryError(e: unknown, timeoutMs: number): unknown {
  if (e instanceof QueryError) return e;
  // Drizzle (a route's `db`) wraps the Postgres error.
  if (e instanceof DrizzleQueryError) {
    const inner = asQueryError(e.cause, timeoutMs);
    return inner instanceof QueryError ? inner : e;
  }
  if (errorCode(e) === "57014") return new QueryError(`query cancelled after ${timeoutMs} ms`);
  if (clientError(e)) return new QueryError((e as Error).message);
  return e;
}

/**
 * Read-only access for the API. Queries run as a role that can only SELECT the app's tables (its password derived
 * from the database URL, so every process on the schema agrees on it), on connections whose transactions are
 * read-only, on the app's schema, with the API's timeouts.
 */
export class Reader {
  /** Every connection read-only, on the app's schema. */
  readonly pool: pg.Pool;
  readonly #schema: string;
  readonly timeoutMs: number;

  private constructor(url: string, o: ReaderOptions) {
    this.timeoutMs = o.timeoutMs ?? API_TIMEOUT_MS;
    this.pool = new RetryingPool({
      connectionString: url,
      max: API_POOL_SIZE,
      options: [
        `-c search_path=${quote(o.schema)}`,
        "-c default_transaction_read_only=on",
        `-c statement_timeout=${this.timeoutMs}`,
        `-c lock_timeout=${API_LOCK_TIMEOUT_MS}`,
      ].join(" "),
    });
    this.#schema = o.schema;
  }

  static async connect(o: ReaderOptions): Promise<Reader> {
    let url = o.readDatabase;
    const owner = new pg.Client({ connectionString: o.database });
    await owner.connect();
    try {
      let role: string;
      await owner.query("BEGIN");
      // Processes starting at once would race to create the role and grant to it.
      await owner.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${o.schema}_reader`]);
      if (url === undefined) {
        role = `${o.schema}_reader`;
        // The same for every process on this database and schema: one starting (a deploy, `serve`) sets the
        // password the others already use, instead of locking them out.
        const password = createHmac("sha256", o.database).update(role).digest("hex");
        await owner.query(
          `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role.replace(/'/g, "''")}') THEN CREATE ROLE ${quote(role)} LOGIN; END IF; END $$`,
        );
        await owner.query(
          `ALTER ROLE ${quote(role)} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}'`,
        );
        const u = new URL(o.database);
        u.username = role;
        u.password = password;
        url = u.toString();
      } else {
        role = decodeURIComponent(new URL(url).username);
      }
      await owner.query(`GRANT USAGE ON SCHEMA ${quote(o.schema)} TO ${quote(role)}`);
      for (const t of o.tables)
        await owner.query(`GRANT SELECT ON ${quote(o.schema)}.${quote(t.name)} TO ${quote(role)}`);
      await owner.query(`GRANT SELECT ON ${quote(o.schema)}._kasbah_meta TO ${quote(role)}`);
      await owner.query("COMMIT");
    } finally {
      await owner.end();
    }
    return new Reader(url, o);
  }

  async close() {
    await this.pool.end();
  }
}
