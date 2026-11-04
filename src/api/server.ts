import { createServer, type Server } from "node:http";
import { serve } from "@hono/node-server";
import { is } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgTable } from "drizzle-orm/pg-core";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { ConfigError } from "../config/errors.ts";
import { tableInfo } from "../db/table.ts";
import {
  type ApiApp,
  type ApiContext,
  apiContext,
  detailedErrors,
  type Tables,
} from "./context.ts";
import { prometheus } from "./prometheus.ts";
import { Reader, type ReaderOptions } from "./reader.ts";
import { type Meta, readMeta, readStatus } from "./status.ts";

export type ApiOptions = Omit<ReaderOptions, "tables"> & {
  /** Tables, and Drizzle `relations()` between them: a schema module works as is. */
  tables: Tables;
  port: number;
  host?: string;
  /** Mounted after the built-in endpoints. */
  app?: ApiApp;
  /** `GET /metrics` in Prometheus' format: the indexer's, when it runs the API; else the checkpoint and phase. */
  metrics?: () => string;
};

/** A request body's size at most: a GraphQL query or a route's JSON is far smaller, and the body is read whole. */
const MAX_BODY = 1 << 20;

/** Browsers may cache a CORS preflight's answer this long (seconds). */
const CORS_MAX_AGE = 86_400;

/** On close, open requests get this long before their connections are cut. */
const CLOSE_GRACE_MS = 1_000;

/** The phases in which the backfill is done: `/ready` answers 200. */
const READY_PHASES = new Set(["live", "done"]);

/**
 * The HTTP API: `/health`, `/ready`, `/status` and `/metrics`, then the app's Hono app. Each request runs with its
 * API's context (`db` and `graphql()` from `kasbah/api` read it), and every query through it runs as
 * the read-only reader.
 */
export class Api {
  readonly #reader: Reader;
  readonly #server: Server;

  private constructor(reader: Reader, server: Server) {
    this.#reader = reader;
    this.#server = server;
  }

  static async start(o: ApiOptions): Promise<Api> {
    const infos = Object.values(o.tables).flatMap((t) => (is(t, PgTable) ? [tableInfo(t)] : []));
    const reader = await Reader.connect({ ...o, tables: infos });
    const context: ApiContext = {
      db: drizzle(reader.pool, { schema: o.tables }),
      reader,
      tables: o.tables,
    };
    const root = routes(reader, o);
    const server = serve({
      fetch: (request, env) => apiContext.run(context, () => root.fetch(request, env)),
      createServer,
      port: o.port,
      hostname: o.host ?? "127.0.0.1",
    }) as Server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        if (server.listening) resolve();
        else server.once("listening", resolve);
      });
      return new Api(reader, server);
    } catch (e) {
      server.close();
      await reader.close();
      if ((e as NodeJS.ErrnoException).code === "EADDRINUSE")
        throw new ConfigError(
          `port ${o.port} is in use: stop what runs there, or pick another with --port (or PORT)`,
        );
      throw e;
    }
  }

  get port(): number {
    const a = this.#server.address();
    return typeof a === "object" && a !== null ? a.port : 0;
  }

  async close() {
    await new Promise<void>((resolve) => {
      const cut = setTimeout(() => this.#server.closeAllConnections(), CLOSE_GRACE_MS);
      this.#server.close(() => {
        clearTimeout(cut);
        resolve();
      });
      this.#server.closeIdleConnections();
    });
    await this.#reader.close();
  }
}

function routes(reader: Reader, o: ApiOptions): Hono {
  const root = new Hono()
    .use(cors({ origin: "*", maxAge: CORS_MAX_AGE }))
    .use(
      bodyLimit({
        maxSize: MAX_BODY,
        onError: (c) => c.text(`request body over ${MAX_BODY / 2 ** 20} MB`, 413),
      }),
    )
    .get("/metrics", async (c) => c.text(o.metrics?.() ?? storedMetrics(await readMeta(reader))))
    .get("/health", (c) => c.text("", 200))
    .get("/ready", async (c) =>
      READY_PHASES.has((await readMeta(reader)).phase ?? "")
        ? c.text("", 200)
        : c.text("Historical indexing is not complete.", 503),
    )
    .get("/status", async (c) => c.json(await readStatus(reader)));
  if (o.app instanceof Hono) root.route("/", o.app);
  else if (o.app !== undefined) {
    const app = o.app;
    root.all("*", (c) => app.fetch(c.req.raw));
  }
  return root.onError(onError);
}

function storedMetrics(m: Meta): string {
  return prometheus([
    {
      name: "phase",
      type: "gauge",
      help: "The phase running (1).",
      samples: [[{ phase: m.phase ?? "starting" }, 1]],
    },
    {
      name: "checkpoint",
      type: "gauge",
      help: "Last block committed.",
      samples: [[{}, Number(m.checkpoint ?? 0)]],
    },
  ]);
}

/** Where in the app's code an error was thrown: the first file in its stack. */
const FILE = /(\S+\.(?:js|ts|mjs|cjs)):\d+:\d+/;

function onError(thrown: Error, c: Context): Response {
  if (thrown instanceof HTTPException) return thrown.getResponse();
  // Drizzle's error says only which query failed; Postgres's says why.
  const error =
    thrown instanceof DrizzleQueryError && thrown.cause instanceof Error ? thrown.cause : thrown;
  const found = error.stack?.match(FILE)?.[0]?.trim();
  const file = found?.replace(/^\(/, "").replace(/^file:\/\//, "");
  console.error(`[kasbah api] ${c.req.method} ${c.req.path}:`, thrown);
  if (!detailedErrors()) return c.text("Internal Server Error", 500);
  return c.text(
    `${error.name}: ${error.message} occurred in '${file}' while handling a '${c.req.method}' request to the route '${c.req.path}'`,
    500,
  );
}
