import pg from "pg";
import type { ApiApp } from "./api/context.ts";
import type { Checked, Config, Handler, HandlerName, Project, RunOptions } from "./config/app.ts";
import { ConfigError } from "./config/errors.ts";
import { resolveConfig, schemaName } from "./config/resolve.ts";
import { inUse } from "./indexer/lock.ts";
import { apiUrl, run } from "./indexer/run.ts";
import { quote } from "./utils/quote.ts";

/**
 * The app: `kasbah(config)`, then its handlers with `on`. The CLI loads a project's config, handlers and API onto
 * it, then runs, serves or drops it.
 */
export function kasbah<const C extends Config>(initial: C & Checked<C>) {
  let config: Config = initial;
  const handlers = new Map<string, Handler<C, HandlerName<C>>>();

  let apiApp: ApiApp | undefined;

  const on = <N extends HandlerName<C>>(name: N, handler: Handler<C, N>) => {
    if (handlers.has(name)) throw new ConfigError(`${name} already has a handler`);
    handlers.set(name, handler as never);
  };

  /** The API alone, over what an indexer of this app stores: another process, or an earlier run. */
  const serve = async (): Promise<{ url: string; close: () => Promise<void> }> => {
    const resolved = resolveConfig(config);
    if (resolved.api === undefined)
      throw new ConfigError("serve needs the API, which `api` turns off");
    const { Api } = await import("./api/server.ts");
    const api = await Api.start({
      ...resolved.api,
      database: resolved.database,
      schema: resolved.schema,
      tables: resolved.tables,
      app: apiApp,
    });
    return { url: apiUrl(resolved.api, api.port), close: () => api.close() };
  };

  /** Drops the app's schema (its tables and progress), nothing else in the database. Returns the schema. */
  const drop = async (): Promise<string> => {
    const { schema, database } = resolveConfig(config);
    const pool = new pg.Pool({ connectionString: database, max: 1 });
    try {
      if (await inUse(pool, schema))
        throw new ConfigError(`schema "${schema}" is in use by a running indexer: stop it first`);
      await pool.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
    } finally {
      await pool.end();
    }
    return schema;
  };

  return {
    on,
    /** The app's HTTP endpoints: a Hono app, mounted after the built-in ones. The CLI passes `src/api/index.ts`. */
    api: (app: ApiApp) => {
      if (config.api === false) throw new ConfigError("the API is off (`api: false`)");
      apiApp = app;
    },
    run: (options: RunOptions = {}) => run(resolveConfig(config), handlers, options, apiApp),
    serve,
    drop,
    /**
     * For the CLI, before the project's handlers and API load: what the config leaves out, the layout gives. The
     * schema is the directory's name, the tables `kasbah.schema.ts`, and the API is on.
     */
    useProject: (p: Project) => {
      if (p.schemaRequired && config.schema === undefined && !process.env.DATABASE_SCHEMA)
        throw new ConfigError(
          "no schema: pass --schema or set DATABASE_SCHEMA (a new one per deploy), or set `schema` in the config",
        );
      config = {
        ...config,
        schema: config.schema ?? schemaName(p.name),
        tables: config.tables ?? p.tables,
        api: config.api ?? {},
      };
    },
  };
}
