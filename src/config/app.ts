import type { Relations } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import pg from "pg";
import type { Abi } from "../abi/abi.ts";
import type { EventArgs, EventName } from "../abi/types.ts";
import type { Route, RouteHandler } from "../api/routes.ts";
import { Api } from "../api/server.ts";
import type { Db } from "../db/store.ts";
import { quote } from "../db/table.ts";
import type { Client } from "../indexer/client.ts";
import type { FilterConfig } from "../indexer/filters.ts";
import { apiUrl, run } from "../indexer/run.ts";
import type { Status } from "../indexer/status.ts";
import type { Include } from "../sync/extras.ts";
import type { Block } from "../types/block.ts";
import type { Receipt, Transaction } from "../types/transaction.ts";
import { ConfigError } from "./errors.ts";
import type { Network } from "./network.ts";
import { resolveConfig, schemaName } from "./resolve.ts";
import type { RpcConfig } from "./rpc.ts";

/** Children are the `parameter` (an address) of every `event` the factory at `address` emits. */
export type FactoryConfig = { address: string; abi: Abi; event: string; parameter: string };

/** A block number, or `"deployment"`: the block the contract (a factory's, for a factory) was deployed in. */
export type StartBlock = number | "deployment";

export type ContractConfig<S extends StartBlock = StartBlock> = {
  abi: Abi;
  startBlock: S;
  /** Last block indexed for it (inclusive): nothing after it is fetched. */
  endBlock?: number;
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
  /**
   * Only events whose arguments have these values (one, or a list of allowed ones): `{ Transfer: { to: "0x…" } }`.
   * Filtered key arguments are filtered by the node, so only matches are fetched; data arguments after decoding.
   */
  filter?: FilterConfig;
} & (
  | {
      /** One address, or several sharing the ABI and handlers (`event.address` tells them apart). */
      address: string | readonly string[];
      factory?: undefined;
    }
  | { factory: FactoryConfig; address?: undefined }
);

/** A handler every `interval` blocks from `startBlock` (inclusive), after that block's events. */
export type BlockConfig = { interval: number; startBlock: number; endBlock?: number };

/** The app's tables, and optionally Drizzle `relations()` for GraphQL: `import * as schema` works as is. */
export type Tables = Record<string, PgTable | Relations>;

export type Config = {
  /** Refuse to start when the RPC is on another chain. Without it, the chain is whichever the RPC is on. */
  network?: Network;
  /** A URL, `{ url, maxRequestsPerSecond }`, or several with `loadBalance([...])`. */
  rpc: RpcConfig;
  /** Default: `DATABASE_URL`. */
  database?: string;
  /**
   * Postgres schema holding the app's tables. `DATABASE_SCHEMA` (the CLI's `--schema`) wins over it. Default: the
   * project directory's name under the CLI, `kasbah` from code.
   */
  schema?: string;
  contracts: Record<string, ContractConfig>;
  blocks?: Record<string, BlockConfig>;
  /** Default, under the CLI: what `kasbah.schema.ts` exports. */
  tables?: Tables;
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
  /**
   * The read API (SQL over HTTP, GraphQL, the app's `get`/`post` routes), served while indexing. The CLI serves it
   * unless `false`; from code, only when given. `PORT` (`--port`) and `API_HOST` (`--hostname`) win over `port`
   * (default 42069) and `host`.
   */
  api?: false | { port?: number; host?: string; readDatabase?: string };
  /**
   * Keep final raw events and call results in Postgres (schema `kasbah_cache_<chain>`), so a re-index refetches
   * nothing. `maxCalls`: call results kept, oldest dropped first (default 1M).
   */
  cache?: boolean | { maxCalls?: number };
};

export const createConfig = <const C extends Config>(config: C): C => config;

type Contracts<C extends Config> = C["contracts"];
type TablesOf<C extends Config> = C["tables"] extends Tables ? C["tables"] : Tables;
type Blocks<C extends Config> =
  C["blocks"] extends Record<string, BlockConfig> ? C["blocks"] : Record<never, never>;

type EventHandlerName<C extends Config> = {
  [K in keyof Contracts<C> & string]: `${K}:${EventName<Contracts<C>[K]["abi"]>}`;
}[keyof Contracts<C> & string];

export type HandlerName<C extends Config> =
  | EventHandlerName<C>
  | `${keyof Blocks<C> & string}:block`;

export type IndexedBlock<K extends string = string> = { source: K; block: Block };

type IncludeOf<C extends Config, K extends keyof Contracts<C>> = Contracts<C>[K] extends {
  include: infer I;
}
  ? I
  : {};

export type IndexedEvent<
  C extends Config,
  N extends HandlerName<C>,
> = N extends `${infer K}:${infer E}`
  ? K extends keyof Contracts<C> & string
    ? E extends EventName<Contracts<C>[K]["abi"]>
      ? {
          contract: K;
          name: E;
          args: EventArgs<Contracts<C>[K]["abi"], E>;
          address: `0x${string}`;
          /** With `include.block`, the whole header (timestamp, gas prices, …); without, the number and hash the event carries. */
          block: IncludeOf<C, K> extends { block: true }
            ? Block
            : { number: number; hash: string | undefined };
          /** With `include.transaction`, the whole `Transaction` (narrow it by `type` and `version`). */
          transaction: { hash: string; index: number } & (IncludeOf<C, K> extends {
            transaction: true;
          }
            ? Transaction
            : {});
          /** The event as emitted, before decoding: `keys[0]` is the selector of its name. */
          log: { keys: `0x${string}`[]; data: `0x${string}`[] };
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

/** A filter value: the argument's type (a number for an integer too), or a list of them. */
type FilterValue<V> = V extends bigint
  ? bigint | number | readonly (bigint | number)[]
  : V | readonly V[];

/** `filter` as written, with each event and argument checked against the ABI: a misspelled name is `never`. */
type FilterOf<A extends Abi, F> = {
  [E in keyof F]: E extends EventName<A>
    ? {
        [K in keyof F[E]]: K extends keyof EventArgs<A, E>
          ? FilterValue<EventArgs<A, E>[K]>
          : never;
      }
    : never;
};

/** `upgradeEvents` and `filter` are events of each contract's ABI. */
type Checked<C extends Config> = {
  contracts: {
    [K in keyof Contracts<C>]: {
      upgradeEvents?: readonly EventName<Contracts<C>[K]["abi"]>[];
      filter?: FilterOf<Contracts<C>[K]["abi"], NonNullable<Contracts<C>[K]["filter"]>>;
    };
  };
};

/** What a project's layout gives the CLI: its directory's name, and what `kasbah.schema.ts` exports. */
export type Project = { name: string; tables?: Tables };

export function kasbah<const C extends Config>(initial: C & Checked<C>) {
  let config: Config = initial;
  const handlers = new Map<string, Handler<C, HandlerName<C>>>();

  const routes: Route[] = [];

  const on = <N extends HandlerName<C>>(name: N, handler: Handler<C, N>) => {
    if (handlers.has(name)) throw new ConfigError(`${name} already has a handler`);
    handlers.set(name, handler as never);
  };

  /** An endpoint of the API (`/pools/:key`), read-only on the app's tables; needs the API on. */
  const route = (method: Route["method"]) => (path: string, handler: RouteHandler<TablesOf<C>>) => {
    if (config.api === undefined || config.api === false)
      throw new ConfigError(`${method} ${path}: routes need the API, which \`api\` turns off`);
    routes.push({ method, path, handler: handler as never });
  };

  /** The API alone, over what an indexer of this app stores: another process, or an earlier run. */
  const serve = async (): Promise<{ url: string; close: () => Promise<void> }> => {
    const resolved = resolveConfig(config);
    if (resolved.api === undefined)
      throw new ConfigError("serve needs the API, which `api` turns off");
    const api = await Api.start({
      ...resolved.api,
      database: resolved.database,
      schema: resolved.schema,
      tables: resolved.tables,
      routes,
    });
    return { url: apiUrl(resolved.api, api.port), close: () => api.close() };
  };

  /** Drops the app's schema (its tables and progress), nothing else in the database. Returns the schema. */
  const drop = async (): Promise<string> => {
    const { schema, database } = resolveConfig(config);
    const pool = new pg.Pool({ connectionString: database, max: 1 });
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
    } finally {
      await pool.end();
    }
    return schema;
  };

  return {
    on,
    get: route("GET"),
    post: route("POST"),
    run: (options: RunOptions = {}) => run(resolveConfig(config), handlers, options, routes),
    serve,
    drop,
    /**
     * For the CLI, before the project's handlers and routes load: what the config leaves out, the layout gives. The
     * schema is the directory's name, the tables `kasbah.schema.ts`, and the API is on.
     */
    useProject: (p: Project) => {
      config = {
        ...config,
        schema: config.schema ?? schemaName(p.name),
        tables: config.tables ?? p.tables,
        api: config.api ?? {},
      };
    },
  };
}
