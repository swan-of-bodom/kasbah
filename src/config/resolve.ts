import type { RpcEndpoint } from "../rpc/client.ts";
import type { BlockConfig, Config, ContractConfig, StartBlock, Tables } from "./app.ts";
import { ConfigError } from "./errors.ts";
import { endpointsOf } from "./rpc.ts";

/** What the config may leave out: each default is applied here and read nowhere else. */
export const DEFAULTS = {
  /** Postgres schema for the app's tables and progress, from code; the CLI defaults to the project's name. */
  schema: "kasbah",
  port: 42069,
  /** Parallel `getEvents` windows, and the RPC client's cap on requests in flight. */
  concurrency: 32,
  /** Blocks behind the tip a reorg can still replace: indexed live, with an undo journal. */
  reorgWindow: 64,
  /** Head polling interval, ms. */
  pollMs: 2_000,
  /** Call results the cache keeps, oldest dropped first. */
  maxCalls: 1_000_000,
} as const;

/**
 * The config with every default applied: what the indexer, `serve` and `drop` read. Start blocks are numbers once
 * the indexer has found the `"deployment"` ones (`S`).
 */
export type Resolved<S extends StartBlock = number> = Omit<
  Config,
  | "contracts"
  | "rpc"
  | "database"
  | "schema"
  | "tables"
  | "api"
  | "concurrency"
  | "reorgWindow"
  | "pollMs"
  | "ws"
  | "cache"
  | "blocks"
> & {
  contracts: Record<string, ContractConfig<S>>;
  rpc: RpcEndpoint[];
  database: string;
  schema: string;
  tables: Tables;
  /** None when the API is off. */
  api: { port: number; host?: string; readDatabase?: string } | undefined;
  concurrency: number;
  reorgWindow: number;
  pollMs: number;
  /** New heads' WebSocket URL (for `ws: true`, the RPC URL's), or none: poll only. */
  ws: string | undefined;
  cache: { maxCalls: number };
  blocks: Record<string, BlockConfig>;
};

/** `DATABASE_SCHEMA`, `PORT` and `API_HOST` win over the config, so one config deploys anywhere. */
export function resolveConfig(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): Resolved<StartBlock> {
  const database = config.database ?? env.DATABASE_URL;
  if (database === undefined || database === "")
    throw new ConfigError("no database: set DATABASE_URL, or `database` in the config");
  if (config.tables === undefined)
    throw new ConfigError("no tables: export them from kasbah.schema.ts, or pass `tables`");
  const port = env.PORT ? Number(env.PORT) : undefined;
  if (port !== undefined && !Number.isInteger(port))
    throw new ConfigError(`PORT=${env.PORT} is not a port number`);
  if (typeof config.cache === "boolean")
    throw new ConfigError(
      `cache: ${config.cache} is no longer an option: the event cache is always on. Remove it`,
    );
  const rpc = endpointsOf(config.rpc);
  if (config.finality !== undefined && config.reorgWindow !== undefined)
    throw new ConfigError('`finality: "l1"` and `reorgWindow` both set: L1 finality has no window');
  return {
    ...config,
    rpc,
    database,
    schema: env.DATABASE_SCHEMA || config.schema || DEFAULTS.schema,
    tables: config.tables,
    api:
      config.api === undefined || config.api === false
        ? undefined
        : {
            ...config.api,
            port: port ?? config.api.port ?? DEFAULTS.port,
            host: env.API_HOST || config.api.host,
          },
    concurrency: config.concurrency ?? DEFAULTS.concurrency,
    reorgWindow: config.reorgWindow ?? DEFAULTS.reorgWindow,
    pollMs: config.pollMs ?? DEFAULTS.pollMs,
    ws: config.ws === true ? rpc[0]!.url.replace(/^http/, "ws") : config.ws,
    cache: { maxCalls: config.cache?.maxCalls ?? DEFAULTS.maxCalls },
    blocks: config.blocks ?? {},
  };
}

/** A project directory's name as a Postgres schema: `my-indexer` and `myIndexer` give `my_indexer`. */
export function schemaName(name: string): string {
  const s = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (s === "") return DEFAULTS.schema;
  return (/^[0-9]/.test(s) ? `_${s}` : s).slice(0, 63);
}
