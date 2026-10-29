import { createHmac } from "node:crypto";
import { DrizzleQueryError } from "drizzle-orm/errors";
import pg from "pg";
import { quote, type TableInfo } from "../db/table.ts";
import { errorCode } from "../utils/errors.ts";

export type ReaderOptions = {
  /** Connection the indexer writes with; used once to set up the reader role. */
  database: string;
  schema: string;
  tables: TableInfo[];
  /** A login that may only read the app's tables. Without it, kasbah creates `<schema>_reader` (needs CREATEROLE). */
  readDatabase?: string;
  /** Per query. Default 10 s. */
  timeoutMs?: number;
  /** Rows a SQL query may return. Default 10,000. */
  maxRows?: number;
};

export class QueryError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Names Postgres gives errors a reader can cause; everything else is ours (500). */
const CLIENT_ERRORS = new Set(["42", "22", "0A", "21", "25", "54", "57014"]);
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
 * from the database URL, so every process on the schema agrees on it), in a read-only
 * transaction with a timeout that is always rolled back, so nothing a query sets outlives it.
 */
export class Reader {
  readonly #pool: pg.Pool;
  readonly #url: string;
  readonly #schema: string;
  readonly timeoutMs: number;
  readonly maxRows: number;

  private constructor(url: string, o: ReaderOptions) {
    this.#url = url;
    this.#pool = new pg.Pool({ connectionString: url, max: 8 });
    this.#schema = o.schema;
    this.timeoutMs = o.timeoutMs ?? 10_000;
    this.maxRows = o.maxRows ?? 10_000;
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

  /** Runs `body` in a read-only transaction on the app's schema, then rolls it back. */
  async transaction<T>(body: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    let broken: Error | undefined;
    try {
      await client.query(
        `BEGIN READ ONLY; SET LOCAL statement_timeout = ${this.timeoutMs}; SET LOCAL search_path TO ${quote(this.#schema)}`,
      );
      try {
        return await body(client);
      } catch (e) {
        throw asQueryError(e, this.timeoutMs);
      } finally {
        // A failed ROLLBACK leaves the connection unusable: dropped, and the query's own error kept.
        await client.query("ROLLBACK").catch((e: Error) => (broken = e));
      }
    } finally {
      client.release(broken);
    }
  }

  /**
   * One read query, at most `maxRows` rows. Wrapped as a subquery (so only SELECT, VALUES and WITH parse) and sent
   * with the extended protocol (so it is exactly one statement). `$1`… in `text` are `params`.
   */
  async sql(
    text: string,
    params: unknown[] = [],
  ): Promise<{ columns: string[]; rows: unknown[][] }> {
    const body = text.trim().replace(/;\s*$/, "");
    if (body === "") throw new QueryError("empty query");
    // The limit as the last parameter: values are never empty, so pg always uses the extended protocol.
    const values = [...params, this.maxRows + 1];
    const result = await this.transaction((c) =>
      c.query({
        text: `SELECT * FROM (\n${body}\n) AS _q LIMIT $${values.length}`,
        values,
        rowMode: "array",
      }),
    );
    if (result.rows.length > this.maxRows)
      throw new QueryError(`more than ${this.maxRows} rows: add a LIMIT`);
    return { columns: result.fields.map((f) => f.name), rows: result.rows as unknown[][] };
  }

  /** `LISTEN`s on `channel` on its own connection, reconnecting after errors. Returns a function that stops it. */
  async listen(
    channel: string,
    onPayload: (payload: string) => void,
  ): Promise<() => Promise<void>> {
    let client: pg.Client | undefined;
    let stopped = false;
    const connect = async (): Promise<void> => {
      const c = new pg.Client({ connectionString: this.#url });
      c.on("notification", (n) => n.channel === channel && onPayload(n.payload ?? ""));
      c.on("error", () => {
        if (stopped) return;
        client = undefined;
        void c.end().catch(() => {});
        setTimeout(() => void connect().catch(() => {}), 1_000);
      });
      await c.connect();
      await c.query(`LISTEN ${quote(channel)}`);
      client = c;
      // Commits during the reconnect were missed: tell listeners to look again.
      onPayload("");
    };
    await connect();
    return async () => {
      stopped = true;
      await client?.end();
    };
  }

  async close() {
    await this.#pool.end();
  }
}
