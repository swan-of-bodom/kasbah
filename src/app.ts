import type { Block } from "./block.ts";
import type { Relations } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Abi } from "./abi/abi.ts";
import type { Route, RouteHandler } from "./api/routes.ts";
import { Api } from "./api/server.ts";
import type { EventArgs, EventName } from "./abi/types.ts";
import type { Client } from "./client.ts";
import type { Db } from "./db/store.ts";
import type { Receipt, Transaction } from "./rpc/methods.ts";
import { apiUrl, DEFAULT_SCHEMA, run } from "./run.ts";
import type { Status } from "./status.ts";
import type { Include } from "./sync/extras.ts";

/** Children are the `parameter` (an address) of every `event` the factory at `address` emits. */
export type FactoryConfig = { address: string; abi: Abi; event: string; parameter: string };

export type ContractConfig = {
  abi: Abi;
  startBlock: number;
  /**
   * Fetch each event's transaction and/or receipt (one request per transaction hash, cached when final), and/or
   * its block's header, `Block` (one per block with events, cached when final).
   */
  include?: Include;
  /**
   * Events announcing a class replacement: while following the head, the class is read again only when one is
   * emitted. Default: `Upgraded`, `ClassHashReplaced` or `ImplementationReplaced` if the ABI declares them; without
   * any, the class is checked at every poll. `[]`: never upgrades, never checked.
   */
  upgradeEvents?: readonly string[];
} & ({ address: string; factory?: undefined } | { factory: FactoryConfig; address?: undefined });

/** A handler every `interval` blocks from `startBlock` (inclusive), after that block's events. */
export type BlockConfig = { interval: number; startBlock: number; endBlock?: number };

export type Config = {
  rpc: string;
  database: string;
  /** Postgres schema holding the app's tables. */
  schema?: string;
  contracts: Record<string, ContractConfig>;
  blocks?: Record<string, BlockConfig>;
  /** The app's tables, and optionally Drizzle `relations()` for GraphQL: `import * as schema` works as is. */
  tables: Record<string, PgTable | Relations>;
  /** Parallel `getEvents` windows. */
  concurrency?: number;
  /** Blocks behind the tip that can still be reorged: indexed live, with an undo journal. Default 64. */
  reorgWindow?: number;
  /** Head polling interval. Default 2 s. */
  pollMs?: number;
  /**
   * WebSocket endpoint for `starknet_subscribeNewHeads` (`true`: the `rpc` URL with `ws` for `http`). Heads only
   * wake the follower, which then fetches as when polling; while the socket is down it polls every `pollMs`.
   */
  ws?: string | true;
  /** Serve the read API (SQL over HTTP, GraphQL, the app's `get`/`post` routes) while indexing. */
  api?: { port: number; host?: string; readDatabase?: string };
  /**
   * Keep final raw events and call results in Postgres (schema `kasbah_cache_<chain>`), so a re-index refetches
   * nothing. `maxCalls`: call results kept, oldest dropped first (default 1M).
   */
  cache?: boolean | { maxCalls?: number };
};

export const createConfig = <const C extends Config>(config: C): C => config;

type Contracts<C extends Config> = C["contracts"];
type Blocks<C extends Config> = C["blocks"] extends Record<string, BlockConfig> ? C["blocks"] : Record<never, never>;

type EventHandlerName<C extends Config> = {
  [K in keyof Contracts<C> & string]: `${K}:${EventName<Contracts<C>[K]["abi"]>}`;
}[keyof Contracts<C> & string];

export type HandlerName<C extends Config> = EventHandlerName<C> | `${keyof Blocks<C> & string}:block`;

export type IndexedBlock<K extends string = string> = { source: K; block: Block };

type IncludeOf<C extends Config, K extends keyof Contracts<C>> = Contracts<C>[K] extends { include: infer I } ? I : {};

export type IndexedEvent<C extends Config, N extends HandlerName<C>> = N extends `${infer K}:${infer E}`
  ? K extends keyof Contracts<C> & string
    ? E extends EventName<Contracts<C>[K]["abi"]>
      ? {
          contract: K;
          name: E;
          args: EventArgs<Contracts<C>[K]["abi"], E>;
          address: `0x${string}`;
          /** With `include.block`, the whole header (timestamp, gas prices, …); without, the number and hash the event carries. */
          block: IncludeOf<C, K> extends { block: true } ? Block : { number: number; hash: string | undefined };
          /** With `include.transaction`, also the transaction's fields as the RPC returns them. */
          transaction: { hash: string; index: number } & (IncludeOf<C, K> extends { transaction: true } ? Transaction : {});
          /** Position of the event in its transaction. */
          index: number;
        } & (IncludeOf<C, K> extends { receipt: true } ? { receipt: Receipt } : {})
      : never
    : K extends keyof Blocks<C> & string
      ? E extends "block"
        ? IndexedBlock<K>
        : never
      : never
  : never;

export type Handler<C extends Config, N extends HandlerName<C>> = (arg: {
  event: IndexedEvent<C, N>;
  /** `client` reads contract state at the end of the block being indexed (cached once the block is final). */
  context: { db: Db; client: Client };
}) => void | Promise<void>;

export type RunOptions = {
  /** Index up to this block and stop. Without it, backfill then follow the head until `signal` aborts. */
  to?: number;
  /** Drop the app's schema first. */
  reset?: boolean;
  /**
   * The schema holds another build (config, tables or handlers changed): `"error"` (default) refuses to start,
   * `"reset"` drops it and indexes from scratch (what `kasbah dev` does).
   */
  onBuildChange?: "error" | "reset";
  /** Part of the build id: the CLI passes a hash of the app's source files, so a change in any helper counts. */
  buildSalt?: string;
  signal?: AbortSignal;
  /**
   * Watch the run yourself: `status` is kept up to date as it goes, and every notice (reorgs, class changes, phase
   * summaries, progress) goes to its `subscribe` listeners. Without it, `run` prints each notice as a `[kasbah]` line.
   */
  status?: Status;
};

/** `upgradeEvents` are events of each contract's ABI. */
type Checked<C extends Config> = { contracts: { [K in keyof Contracts<C>]: { upgradeEvents?: readonly EventName<Contracts<C>[K]["abi"]>[] } } };

export function kasbah<const C extends Config>(config: C & Checked<C>) {
  const handlers = new Map<string, Handler<C, HandlerName<C>>>();

  const routes: Route[] = [];

  const on = <N extends HandlerName<C>>(name: N, handler: Handler<C, N>) => {
    if (handlers.has(name)) throw new Error(`${name} already has a handler`);
    handlers.set(name, handler as never);
  };

  /** An endpoint of the API (`/pools/:key`), read-only on the app's tables; needs `api` in the config. */
  const route = (method: Route["method"]) => (path: string, handler: RouteHandler<C["tables"]>) => {
    if (config.api === undefined) throw new Error(`${method} ${path}: routes need \`api\` in the config`);
    routes.push({ method, path, handler: handler as never });
  };

  /** The API alone (`api` in the config), over what an indexer of this app stores: another process, or an earlier run. */
  const serve = async (): Promise<{ url: string; close: () => Promise<void> }> => {
    if (config.api === undefined) throw new Error("serve needs `api` in the config");
    const api = await Api.start({ ...config.api, database: config.database, schema: config.schema ?? DEFAULT_SCHEMA, tables: config.tables, routes });
    return { url: apiUrl(config.api, api.port), close: () => api.close() };
  };

  return { on, get: route("GET"), post: route("POST"), run: (options: RunOptions = {}) => run(config, handlers, options, routes), serve };
}
