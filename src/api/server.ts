import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { GraphQLError, graphql, type GraphQLSchema } from "graphql";
import type { PgTable } from "drizzle-orm/pg-core";
import { tableInfo } from "../db/table.ts";
import { createGraphqlSchema } from "./graphql.ts";
import { QueryError, Reader, type ReaderOptions } from "./reader.ts";

export type ApiOptions = Omit<ReaderOptions, "tables"> & {
  tables: Record<string, PgTable>;
  port: number;
  host?: string;
};

const MAX_BODY = 1 << 20;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new QueryError("request body over 1 MB", 413));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(json);
}

async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    const body = JSON.parse(await readBody(req));
    if (typeof body === "object" && body !== null && !Array.isArray(body)) return body;
  } catch (e) {
    if (e instanceof QueryError) throw e;
  }
  throw new QueryError("body must be a JSON object");
}

/**
 * The read API: `POST /sql` `{ sql, params? }` → `{ columns, rows }`, `POST /graphql` `{ query, variables? }`,
 * `GET /status`. Everything runs through `Reader` (read-only role and transaction).
 */
export class Api {
  readonly #reader: Reader;
  readonly #schema: GraphQLSchema;
  readonly #server: Server;

  private constructor(reader: Reader, schema: GraphQLSchema) {
    this.#reader = reader;
    this.#schema = schema;
    this.#server = createServer((req, res) => void this.#handle(req, res));
  }

  static async start(o: ApiOptions): Promise<Api> {
    const infos = Object.fromEntries(Object.entries(o.tables).map(([k, t]) => [k, tableInfo(t)]));
    const reader = await Reader.connect({ ...o, tables: Object.values(infos) });
    const api = new Api(reader, createGraphqlSchema(infos));
    await new Promise<void>((resolve, reject) => {
      api.#server.once("error", reject);
      api.#server.listen(o.port, o.host ?? "127.0.0.1", resolve);
    });
    return api;
  }

  get port(): number {
    const a = this.#server.address();
    return typeof a === "object" && a !== null ? a.port : 0;
  }

  async #handle(req: IncomingMessage, res: ServerResponse) {
    try {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST",
          "access-control-allow-headers": "content-type",
        });
        return res.end();
      }
      if (path === "/status" && req.method === "GET") {
        const { rows } = await this.#reader.sql(`SELECT key, value FROM _kasbah_meta WHERE key IN ('checkpoint', 'phase')`);
        return send(res, 200, Object.fromEntries(rows));
      }
      if (path === "/sql" && req.method === "POST") {
        const body = await json(req);
        if (typeof body.sql !== "string") throw new QueryError("`sql` must be a string");
        if (body.params !== undefined && !Array.isArray(body.params)) throw new QueryError("`params` must be an array");
        return send(res, 200, await this.#reader.sql(body.sql, body.params as unknown[] | undefined));
      }
      if (path === "/graphql" && req.method === "POST") {
        const body = await json(req);
        if (typeof body.query !== "string") throw new QueryError("`query` must be a string");
        const result = await this.#reader.transaction((client) =>
          graphql({
            schema: this.#schema,
            source: body.query as string,
            variableValues: (body.variables ?? undefined) as Record<string, unknown> | undefined,
            contextValue: { client, timeoutMs: this.#reader.timeoutMs },
          }),
        );
        const errors = result.errors?.map((e) => {
          const original = e.originalError;
          // Only parse and validation errors, our own messages and Postgres errors a query can cause reach the client.
          const safe = original === undefined || original instanceof QueryError || original instanceof TypeError || original instanceof GraphQLError;
          if (!safe) console.error("[kasbah api]", original);
          return { message: safe ? e.message : "internal error", path: e.path, locations: e.locations };
        });
        return send(res, 200, errors === undefined ? { data: result.data } : { data: result.data, errors });
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      if (e instanceof QueryError) return send(res, e.status, { error: e.message });
      console.error("[kasbah api]", e);
      send(res, 500, { error: "internal error" });
    }
  }

  async close() {
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    await this.#reader.close();
  }
}
