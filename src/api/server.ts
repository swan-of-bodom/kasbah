import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { execute, GraphQLError, type GraphQLSchema, specifiedRules, validate } from "graphql";
import { is, Relations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgTable } from "drizzle-orm/pg-core";
import { tableInfo } from "../db/table.ts";
import { createGraphqlSchema, relationsOf } from "./graphql.ts";
import { parseLimited } from "./limits.ts";
import { QueryError, Reader, type ReaderOptions } from "./reader.ts";
import { matcher, type Route } from "./routes.ts";

export type ApiOptions = Omit<ReaderOptions, "tables"> & {
  /** Tables, and Drizzle `relations()` between them (GraphQL relation fields): a schema module works as is. */
  tables: Record<string, PgTable | Relations>;
  port: number;
  host?: string;
  /** Open `GET /live` streams allowed at once. Default 1,000. */
  maxLive?: number;
  /** The app's own endpoints, matched after the built-in ones. */
  routes?: readonly Route[];
};

/** The channel the indexer notifies on each commit, with `{"checkpoint": n}`. */
export const liveChannel = (schema: string) => `kasbah_${schema}`;

const stringify = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

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
  const json = stringify(body);
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

const parseJson = (text: string | null, name: string): unknown => {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new QueryError(`\`${name}\` must be JSON`);
  }
};

/** GraphiQL for browsers, from unpkg (pinned): the API itself stays dependency-free. */
const GRAPHIQL = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>kasbah GraphQL</title>
  <link rel="stylesheet" href="https://unpkg.com/graphiql@3.8.3/graphiql.min.css" />
  <style>body { margin: 0; height: 100vh; } #graphiql { height: 100vh; }</style>
</head>
<body>
  <div id="graphiql">Loading GraphiQL…</div>
  <script crossorigin src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/graphiql@3.8.3/graphiql.min.js"></script>
  <script>
    const fetcher = GraphiQL.createFetcher({ url: location.origin + location.pathname });
    ReactDOM.createRoot(document.getElementById("graphiql")).render(React.createElement(GraphiQL, { fetcher }));
  </script>
</body>
</html>`;

/**
 * The read API: `POST /sql` `{ sql, params? }` → `{ columns, rows }`, `POST /graphql` `{ query, variables? }`
 * (`GET /graphql`: GraphiQL for a browser, or `?query=`),
 * `GET /status`, and `GET /live` (server-sent events on each commit; with `sql` or `query`, that query's result
 * whenever it changes). Everything runs through `Reader` (read-only role and transaction).
 */
export class Api {
  readonly #reader: Reader;
  readonly #schema: GraphQLSchema;
  readonly #server: Server;
  readonly #live = new Set<(checkpoint: number | undefined) => void>();
  readonly #maxLive: number;
  readonly #tables: Record<string, PgTable | Relations>;
  readonly #routes: { method: string; path: string; match: ReturnType<typeof matcher>; handler: Route["handler"] }[];
  #unlisten: (() => Promise<void>) | undefined;

  private constructor(reader: Reader, schema: GraphQLSchema, o: ApiOptions) {
    this.#reader = reader;
    this.#schema = schema;
    this.#maxLive = o.maxLive ?? 1_000;
    this.#tables = o.tables;
    this.#routes = (o.routes ?? []).map((r) => ({ ...r, match: matcher(r.path) }));
    this.#server = createServer((req, res) => void this.#handle(req, res));
  }

  static async start(o: ApiOptions): Promise<Api> {
    const seen = new Set<string>();
    for (const r of o.routes ?? []) {
      if (seen.has(`${r.method} ${r.path}`)) throw new Error(`route ${r.method} ${r.path} defined twice`);
      seen.add(`${r.method} ${r.path}`);
      matcher(r.path);
    }
    const infos = Object.fromEntries(Object.entries(o.tables).flatMap(([k, t]) => (is(t, PgTable) ? [[k, tableInfo(t)]] : [])));
    const reader = await Reader.connect({ ...o, tables: Object.values(infos) });
    const api = new Api(reader, createGraphqlSchema(infos, relationsOf(o.tables, infos)), o);
    api.#unlisten = await reader.listen(liveChannel(o.schema), (payload) => {
      let checkpoint: number | undefined;
      try {
        checkpoint = payload === "" ? undefined : (JSON.parse(payload) as { checkpoint?: number }).checkpoint;
      } catch {}
      for (const l of api.#live) l(checkpoint);
    });
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
      if (path === "/status" && req.method === "GET") return send(res, 200, await this.#status());
      // For a load balancer or orchestrator: up (and its database reachable), and caught up with the head.
      if (path === "/health" && req.method === "GET") {
        await this.#reader.sql("SELECT 1");
        return send(res, 200, { ok: true });
      }
      if (path === "/ready" && req.method === "GET") {
        const s = await this.#status();
        return send(res, s.phase === "live" || s.phase === "done" ? 200 : 503, s);
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
        return send(res, 200, await this.#graphql(body.query, body.variables));
      }
      if (path === "/graphql" && req.method === "GET") {
        const q = new URL(req.url ?? "/", "http://x").searchParams;
        const query = q.get("query");
        if (query !== null) return send(res, 200, await this.#graphql(query, parseJson(q.get("variables"), "variables")));
        if ((req.headers.accept ?? "").includes("text/html")) {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          return res.end(GRAPHIQL);
        }
        throw new QueryError("GET /graphql takes ?query= (and ?variables=), or open it in a browser for GraphiQL");
      }
      if (path === "/" && req.method === "GET") {
        return send(res, 200, {
          endpoints: [
            "POST /sql {sql, params?}", "POST /graphql {query, variables?}", "GET /graphql (GraphiQL in a browser, or ?query=)", "GET /live (?sql= or ?query=)",
            "GET /status", "GET /health", "GET /ready", ...this.#routes.map((r) => `${r.method} ${r.path}`),
          ],
        });
      }
      if (path === "/live" && req.method === "GET") return await this.#stream(req, res);
      for (const r of this.#routes) {
        const params = r.match(path);
        if (params !== undefined && r.method === req.method) return await this.#route(r.handler, params, req, res);
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      if (e instanceof QueryError) return send(res, e.status, { error: e.message });
      console.error("[kasbah api]", e);
      send(res, 500, { error: "internal error" });
    }
  }

  async #status(): Promise<Record<string, string>> {
    const { rows } = await this.#reader.sql(`SELECT key, value FROM _kasbah_meta WHERE key IN ('checkpoint', 'phase')`);
    return Object.fromEntries(rows as [string, string][]);
  }

  async #route(handler: Route["handler"], params: Record<string, string>, req: IncomingMessage, res: ServerResponse) {
    const text = req.method === "POST" ? await readBody(req) : "";
    const body = text === "" ? undefined : parseJson(text, "body");
    const query = new URL(req.url ?? "/", "http://x").searchParams;
    const out = await this.#reader.transaction(async (client) => {
      const r = await (handler as (c: unknown) => unknown)({ db: drizzle(client, { schema: this.#tables }), params, query, body, request: req });
      // Read inside the transaction: a streamed body could still be querying.
      return r instanceof Response ? { response: r, bytes: Buffer.from(await r.arrayBuffer()) } : { json: r };
    });
    if ("json" in out) return send(res, 200, out.json ?? null);
    const headers: Record<string, string> = { "access-control-allow-origin": "*" };
    out.response.headers.forEach((v, k) => (headers[k] = v));
    res.writeHead(out.response.status, headers);
    res.end(out.bytes);
  }

  async #graphql(query: string, variables: unknown) {
    let document;
    try {
      document = parseLimited(query);
    } catch (e) {
      if (e instanceof GraphQLError) return { errors: [{ message: e.message, locations: e.locations }] };
      throw e;
    }
    const invalid = validate(this.#schema, document, specifiedRules);
    if (invalid.length > 0) return { errors: invalid.map((e) => ({ message: e.message, locations: e.locations })) };
    const result = await this.#reader.transaction(async (client) =>
      execute({
        schema: this.#schema,
        document,
        variableValues: (variables ?? undefined) as Record<string, unknown> | undefined,
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
    return errors === undefined ? { data: result.data } : { data: result.data, errors };
  }

  /**
   * `GET /live`: `event: checkpoint` after each commit; with `?sql=…&params=[…]` or `?query=…&variables={…}`, the
   * query runs at once and again after each commit, and `event: result` is sent when its result changed.
   */
  async #stream(req: IncomingMessage, res: ServerResponse) {
    if (this.#live.size >= this.#maxLive) throw new QueryError("too many live queries", 503);
    const q = new URL(req.url ?? "/", "http://x").searchParams;
    const sql = q.get("sql");
    const query = q.get("query");
    let run: (() => Promise<unknown>) | undefined;
    if (sql !== null) {
      const params = parseJson(q.get("params"), "params");
      if (params !== undefined && !Array.isArray(params)) throw new QueryError("`params` must be an array");
      run = () => this.#reader.sql(sql, params as unknown[] | undefined);
    } else if (query !== null) {
      const variables = parseJson(q.get("variables"), "variables");
      run = () => this.#graphql(query, variables);
    }
    // The first result before the stream opens: a bad query is a plain 400.
    let last = run === undefined ? undefined : stringify(await run());
    if (res.destroyed) return;

    const event = (name: string, data: string) => res.write(`event: ${name}\ndata: ${data}\n\n`);
    let running = false;
    let again = false;
    const rerun = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          try {
            const next = stringify(await run!());
            if (next !== last) event("result", (last = next));
          } catch (e) {
            event("error", stringify({ error: e instanceof QueryError ? e.message : "internal error" }));
          }
        } while (again && !res.destroyed);
      } finally {
        running = false;
      }
    };
    const listener = (checkpoint: number | undefined) => {
      if (checkpoint !== undefined) event("checkpoint", stringify({ checkpoint }));
      if (run !== undefined) void rerun();
    };
    // Listening before the first write: a commit can't fall between the first result and the subscription.
    this.#live.add(listener);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "access-control-allow-origin": "*" });
    res.flushHeaders();
    if (last !== undefined) event("result", last);
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(ping);
      this.#live.delete(listener);
    });
  }

  async close() {
    await this.#unlisten?.();
    // Live streams never end on their own.
    const closed = new Promise<void>((resolve) => this.#server.close(() => resolve()));
    this.#server.closeAllConnections();
    await closed;
    await this.#reader.close();
  }
}
