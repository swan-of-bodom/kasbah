import type { BlockConfig, Config } from "./app.ts";

/** What the config may leave out: each default is applied here and read nowhere else. */
export const DEFAULTS = {
  /** Postgres schema for the app's tables and progress. */
  schema: "kasbah",
  /** Parallel `getEvents` windows, and the RPC client's cap on requests in flight. */
  concurrency: 32,
  /** Blocks behind the tip a reorg can still replace: indexed live, with an undo journal. */
  reorgWindow: 64,
  /** Head polling interval, ms. */
  pollMs: 2_000,
  /** Call results the cache keeps, oldest dropped first. */
  maxCalls: 1_000_000,
} as const;

/** The config with every default applied: what the indexer, `serve` and `drop` read. */
export type Resolved = Omit<
  Config,
  "schema" | "concurrency" | "reorgWindow" | "pollMs" | "ws" | "cache" | "blocks"
> & {
  schema: string;
  concurrency: number;
  reorgWindow: number;
  pollMs: number;
  /** New heads' WebSocket URL (for `ws: true`, the RPC URL's), or none: poll only. */
  ws: string | undefined;
  /** None when the cache is off. */
  cache: { maxCalls: number } | undefined;
  blocks: Record<string, BlockConfig>;
};

export function resolveConfig(config: Config): Resolved {
  return {
    ...config,
    schema: config.schema ?? DEFAULTS.schema,
    concurrency: config.concurrency ?? DEFAULTS.concurrency,
    reorgWindow: config.reorgWindow ?? DEFAULTS.reorgWindow,
    pollMs: config.pollMs ?? DEFAULTS.pollMs,
    ws: config.ws === true ? config.rpc.replace(/^http/, "ws") : config.ws,
    cache: config.cache
      ? {
          maxCalls:
            (config.cache === true ? undefined : config.cache.maxCalls) ?? DEFAULTS.maxCalls,
        }
      : undefined,
    blocks: config.blocks ?? {},
  };
}
