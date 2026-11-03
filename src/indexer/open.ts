import { createHash } from "node:crypto";
import { is } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgTable } from "drizzle-orm/pg-core";
import pg from "pg";
import { classHistory, deployedAt } from "../abi/history.ts";
import type { Route } from "../api/routes.ts";
import { Api } from "../api/server.ts";
import type { BlockConfig, RunOptions, StartBlock } from "../config/app.ts";
import { ConfigError } from "../config/errors.ts";
import { checkNetwork, networkName } from "../config/network.ts";
import type { Resolved } from "../config/resolve.ts";
import { EventCache } from "../db/cache.ts";
import { type Db, Store } from "../db/store.ts";
import { createTableSql, indexSql, quote, tableInfo } from "../db/table.ts";
import { transaction } from "../db/transaction.ts";
import { RpcClient } from "../rpc/client.ts";
import { blockNumber } from "../rpc/methods.ts";
import { type Endpoint, probe } from "../rpc/probe.ts";
import type { BlockRef } from "../sync/live.ts";
import { canonical } from "../types/felt.ts";
import { CallClient, type Client } from "./client.ts";
import { Position } from "./commit.ts";
import type { Child } from "./events.ts";
import { compileFilters } from "./filters.ts";
import { Finality } from "./finality.ts";
import { SchemaLock } from "./lock.ts";
import { metricsOf } from "./metrics.ts";
import { resume } from "./phases/live.ts";
import { type Plan, planOf } from "./plan.ts";
import type { AnyHandler } from "./run.ts";
import { type FactorySource, factoryReader, Sources, upgradeEventsOf } from "./sources.ts";
import type { Status } from "./status.ts";

/** How the API is shown: listening on 127.0.0.1 unless told otherwise, shown as localhost, the same address. */
export const apiUrl = (api: { host?: string }, port: number) =>
  `http://${api.host === undefined || api.host === "127.0.0.1" ? "localhost" : api.host}:${port}`;

export type Factory = FactorySource & { reader: ReturnType<typeof factoryReader> };
export type BlockSource = BlockConfig & { name: string };

/** What `open` builds and every phase reads. Only `position` (through its commit) and `final` ever change. */
export type Run = {
  config: Resolved;
  handlers: ReadonlyMap<string, AnyHandler>;
  status: Status;
  signal: AbortSignal;
  closers: (() => unknown)[];
  schema: string;
  pool: pg.Pool;
  rpc: RpcClient;
  endpoint: Endpoint;
  cache: EventCache | undefined;
  store: Store;
  /** Shared by reference with the fetchers and `follow`: changed in place, never replaced. */
  sources: Sources;
  factories: Factory[];
  blockSources: BlockSource[];
  tables: PgTable[];
  indexes: Map<PgTable, string[]>;
  plan: Plan;
  position: Position;
  finality: Finality;
  /** Blocks at or below this can't be reorged: backfill's end, then the head minus the reorg window. */
  final: number;
  client: CallClient;
  context: { db: Db; client: Client };
  anyInclude: boolean;
  anyBlock: boolean;
};

type Stored = {
  checkpoint: number | undefined;
  discovered: Map<string, number>;
  known: Map<number, string>;
  children: Child[];
  unkeyed: Set<string>;
};

/** Connections the indexer's pool opens: the store's writes, the cache's, and startup reads. */
const POOL_SIZE = 8;

/**
 * Validates the config, opens the database (refusing or dropping another build), the API, the RPC and the
 * cache, reads every class, then undoes a reorg that happened while stopped and watches the stored children.
 */
export async function open(
  configured: Resolved<StartBlock>,
  handlers: ReadonlyMap<string, AnyHandler>,
  routes: readonly Route[],
  options: RunOptions,
  status: Status,
  signal: AbortSignal,
  closers: (() => unknown)[],
): Promise<Run> {
  const { schema } = configured;
  status.schema = schema;
  const blockSources = validate(configured, handlers);
  const tables = Object.values(configured.tables).filter((t): t is PgTable => is(t, PgTable));
  // Built now, so an index kasbah can't create is refused before the backfill, not after it.
  const indexes = new Map(tables.map((t) => [t, indexSql(tableInfo(t))]));
  // Ctrl-C cuts startup's requests short; once indexing starts, a stop waits for the last commit instead.
  const starting = new AbortController();
  const stop = () => starting.abort();
  signal.addEventListener("abort", stop, { once: true });
  // The RPC first: a wrong one (another network) is refused before the schema is touched.
  const rpc = new RpcClient(configured.rpc, {
    maxConcurrency: configured.concurrency,
    signal: starting.signal,
  });
  const endpoint = await probe(rpc);
  const chainId = await chainOf(rpc, configured);
  if (configured.network !== undefined) checkNetwork(configured.network, chainId!);
  const config = await deployments(configured, rpc, status);
  const buildId = buildIdOf(config, handlers, blockSources, tables, options.buildSalt);
  const { pool, lock } = await openSchema(config, options, status, buildId, signal, closers);
  const stored = await startup(pool, schema, tables, buildId);
  if (config.api !== undefined) await startApi(config, config.api, routes, status, closers);

  const store = new Store(drizzle(pool), tables, {
    complete: stored.checkpoint === undefined,
    unkeyed: stored.unkeyed,
  });
  const tip = await blockNumber(rpc);
  const finality = new Finality(rpc, config.finality === "l1" ? undefined : config.reorgWindow);
  const plan = planOf(config, options.to, tip, await finality.finalAt(tip));
  if (plan.clamped && options.to !== undefined)
    status.note({
      kind: "clamped",
      to: options.to,
      through: plan.backfillTo,
      tip,
      rule: finality.rule,
    });
  const cache = config.cache ? await EventCache.open(pool, chainId!, config.cache) : undefined;
  const sources = new Sources(rpc, contractsOf(config, handlers), (n) => status.note(n));
  const factories = await factoriesOf(config, rpc, sources, plan.classTo);
  await Promise.all(
    Object.entries(config.contracts).flatMap(([name, c]) =>
      c.address === undefined
        ? []
        : [c.address].flat().map((a) => sources.add(name, a, c.startBlock, plan.classTo, false)),
    ),
  );
  reportEndpoint(status, { endpoint, tip, rpc, cache, sources, factories, blockSources, stored });

  const watermark =
    factories.length === 0
      ? plan.start - 1
      : Math.min(...factories.map((f) => stored.discovered.get(f.contract) ?? f.startBlock - 1));
  const position = new Position(
    {
      pool,
      store,
      cache,
      factories,
      sources,
      status,
      schema,
      lock,
      final: (): number => partial.final,
      start: plan.start,
    },
    { checkpoint: stored.checkpoint, watermark, known: stored.known },
  );
  const partial = {
    config,
    handlers,
    status,
    signal,
    closers,
    schema,
    pool,
    rpc,
    endpoint,
    cache,
    store,
    sources,
    factories,
    blockSources,
    tables,
    indexes,
    plan,
    position,
    finality,
    final: plan.backfillTo,
    anyInclude: Object.values(config.contracts).some(
      (c) => c.include?.transaction || c.include?.receipt,
    ),
    anyBlock: Object.values(config.contracts).some((c) => c.include?.block),
  };
  const client = new CallClient(rpc, { isFinal: (b) => b <= partial.final, cache });
  const run: Run = Object.assign(partial, { client, context: { db: store.db, client } });
  status.checkpoint = position.checkpoint ?? 0;
  status.calls = client.stats;
  status.watched = () => ({ contracts: sources.watched, children: sources.children });
  await resume(run, stored.children);
  signal.removeEventListener("abort", stop);
  return run;
}

async function chainOf(rpc: RpcClient, config: Resolved<StartBlock>): Promise<string | undefined> {
  if (config.network === undefined && config.cache === undefined && config.rpc.length === 1)
    return undefined;
  const ids = await rpc.requestEach<string>("starknet_chainId", []);
  const names = [...new Set(ids.map((id) => networkName(id)))];
  if (names.length > 1)
    throw new ConfigError(
      `rpc: the endpoints are on different chains (${config.rpc.map((e, i) => `${new URL(e.url).host}: ${networkName(ids[i]!)}`).join(", ")})`,
    );
  return ids[0];
}

async function openSchema(
  config: Resolved,
  options: RunOptions,
  status: Status,
  buildId: string,
  signal: AbortSignal,
  closers: (() => unknown)[],
): Promise<{ pool: pg.Pool; lock: SchemaLock }> {
  const pool = new pg.Pool({
    connectionString: config.database,
    max: POOL_SIZE,
    options: `-c search_path=${quote(config.schema)}`,
  });
  closers.push(() => pool.end());
  const lock = await SchemaLock.acquire(
    pool,
    config.schema,
    { dev: options.onBuildChange === "reset", reset: options.reset === true, buildId },
    status,
    signal,
  );
  closers.push(() => lock.release());
  return { pool, lock };
}

async function startApi(
  config: Resolved,
  api: NonNullable<Resolved["api"]>,
  routes: readonly Route[],
  status: Status,
  closers: (() => unknown)[],
): Promise<void> {
  const server = await Api.start({
    ...api,
    database: config.database,
    schema: config.schema,
    tables: config.tables,
    routes,
    metrics: () => metricsOf(status),
  });
  closers.push(() => server.close());
  status.api = apiUrl(api, server.port);
  status.note({ kind: "api", url: status.api });
}

async function deployments(
  config: Resolved<StartBlock>,
  rpc: RpcClient,
  status: Status,
): Promise<Resolved> {
  const tip = await blockNumber(rpc);
  const contracts = await Promise.all(
    Object.entries(config.contracts).map(async ([name, c]) => {
      if (c.startBlock !== "deployment") return [name, c] as const;
      const blocks = await Promise.all(
        [c.address ?? c.factory.address].flat().map(async (a) => {
          const from = await deployedAt(rpc, a, tip);
          if (from === undefined)
            throw new ConfigError(
              `${name}: startBlock "deployment", but nothing is deployed at ${a}`,
            );
          return from;
        }),
      );
      const first = Math.min(...blocks);
      status.note({ kind: "deployed", contract: name, block: first });
      return [name, { ...c, startBlock: first }] as const;
    }),
  );
  return { ...config, contracts: Object.fromEntries(contracts) as Resolved["contracts"] };
}

function contractsOf(config: Resolved, handlers: ReadonlyMap<string, AnyHandler>) {
  return Object.entries(config.contracts).map(([name, c]) => ({
    name,
    abi: c.abi,
    startBlock: c.startBlock,
    handled: new Set(
      [...handlers.keys()]
        .filter((h) => h.startsWith(`${name}:`))
        .map((h) => h.slice(name.length + 1)),
    ),
    upgrades: upgradeEventsOf(name, c.abi, c.upgradeEvents),
    endBlock: c.endBlock,
    filters: compileFilters(name, c.abi, c.filter),
  }));
}

function reportEndpoint(
  status: Status,
  r: {
    endpoint: Endpoint;
    tip: number;
    rpc: RpcClient;
    cache: EventCache | undefined;
    sources: Sources;
    factories: Factory[];
    blockSources: BlockSource[];
    stored: Stored;
  },
): void {
  Object.assign(status, {
    endpoint: `${r.endpoint.node} ${r.endpoint.spec}`,
    tip: r.tip,
    factories: r.factories.length,
    rpc: r.rpc.stats,
    rate: () => r.rpc.rate,
    endpoints: () => r.rpc.endpoints,
    cache: r.cache?.stats,
  });
  status.note({
    kind: "endpoint",
    node: r.endpoint.node,
    spec: r.endpoint.spec,
    tip: r.tip,
    contracts: r.sources.watched + r.stored.children.length,
    factories: r.factories.length,
    blockSources: r.blockSources.length,
  });
}

const META_SQL = [
  `CREATE TABLE IF NOT EXISTS _kasbah_meta (key text PRIMARY KEY, value jsonb NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS _kasbah_blocks (number integer PRIMARY KEY, hash text NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS _kasbah_journal (block integer NOT NULL, seq bigserial, tbl text NOT NULL, pk jsonb NOT NULL, before jsonb)`,
  `CREATE INDEX IF NOT EXISTS _kasbah_journal_block ON _kasbah_journal (block)`,
  `CREATE TABLE IF NOT EXISTS _kasbah_children (address text PRIMARY KEY, contract text NOT NULL, block integer NOT NULL)`,
];

function validate(
  config: Resolved<StartBlock>,
  handlers: ReadonlyMap<string, AnyHandler>,
): BlockSource[] {
  const blockSources = Object.entries(config.blocks).map(([name, b]) => ({ name, ...b }));
  for (const b of blockSources) {
    if (config.contracts[b.name] !== undefined)
      throw new ConfigError(`${b.name} is both a contract and a block source`);
    if (!(b.interval >= 1)) throw new ConfigError(`${b.name}: interval must be at least 1`);
  }
  for (const h of handlers.keys()) {
    if (h === "setup") continue;
    const [source] = h.split(":");
    if (config.contracts[source!] === undefined && config.blocks[source!] === undefined)
      throw new ConfigError(`handler ${h}: no contract or block source ${source}`);
  }
  return blockSources;
}

function buildIdOf(
  config: Resolved,
  handlers: ReadonlyMap<string, AnyHandler>,
  blockSources: BlockSource[],
  tables: PgTable[],
  salt: string | undefined,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        {
          contracts: Object.entries(config.contracts).map(([k, c]) => [
            k,
            c.address === undefined
              ? [canonical(c.factory.address), c.factory.event, c.factory.parameter]
              : typeof c.address === "string"
                ? canonical(c.address)
                : c.address.map(canonical),
            c.startBlock,
            // Only when set, so a config without them keeps its build id.
            ...(c.endBlock === undefined ? [] : [{ endBlock: c.endBlock }]),
            ...(c.filter === undefined ? [] : [{ filter: c.filter }]),
          ]),
          blocks: blockSources.map((b) => [b.name, b.interval, b.startBlock, b.endBlock ?? null]),
          tables: tables.map((t) => createTableSql(tableInfo(t))),
          handlers: [...handlers].map(([name, h]) => [name, h.toString()]).sort(),
          source: salt ?? null,
        },
        (_, v) => (typeof v === "bigint" ? v.toString() : v),
      ),
    )
    .digest("hex")
    .slice(0, 16);
}

const numberOf = (v: unknown) => (typeof v === "number" ? v : undefined);

function startup(
  pool: pg.Pool,
  schema: string,
  tables: PgTable[],
  buildId: string,
): Promise<Stored> {
  return transaction(pool, async (tx) => {
    for (const sql of META_SQL) await tx.query(sql);
    const meta = new Map(
      (
        await tx.query<{ key: string; value: unknown }>(`SELECT key, value FROM _kasbah_meta`)
      ).rows.map((r) => [r.key, r.value]),
    );
    const build = meta.get("build");
    if (build !== undefined && build !== buildId)
      throw new ConfigError(
        `schema "${schema}" holds another build of this app (config, tables or handlers changed); run with reset`,
      );
    // Keys and indexes come once the backfill is done, or when the store first needs a key.
    for (const t of tables) await tx.query(createTableSql(tableInfo(t), { primaryKey: false }));
    const missing = await tx.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c
       WHERE c.relnamespace = $1::regnamespace AND c.relname = ANY($2) AND NOT EXISTS (SELECT 1 FROM pg_constraint p WHERE p.conrelid = c.oid AND p.contype = 'p')`,
      [quote(schema), tables.map((t) => tableInfo(t).name)],
    );
    await tx.query(`INSERT INTO _kasbah_meta VALUES ('build', $1) ON CONFLICT (key) DO NOTHING`, [
      JSON.stringify(buildId),
    ]);
    const discovered = new Map<string, number>();
    for (const [k, v] of meta)
      if (k.startsWith("discovered:") && typeof v === "number")
        discovered.set(k.slice("discovered:".length), v);
    return {
      checkpoint: numberOf(meta.get("checkpoint")),
      discovered,
      known: new Map(
        (await tx.query<BlockRef>(`SELECT number, hash FROM _kasbah_blocks`)).rows.map((b) => [
          b.number,
          b.hash,
        ]),
      ),
      children: (
        await tx.query<Child>(
          `SELECT address, contract, block FROM _kasbah_children ORDER BY block`,
        )
      ).rows,
      unkeyed: new Set(missing.rows.map((r) => r.name)),
    };
  });
}

function factoriesOf(
  config: Resolved,
  rpc: RpcClient,
  sources: Sources,
  classTo: number,
): Promise<Factory[]> {
  return Promise.all(
    Object.entries(config.contracts).flatMap(([name, c]) => {
      if (c.factory === undefined) return [];
      return [
        (async () => {
          const f: FactorySource = {
            contract: name,
            address: canonical(c.factory.address),
            abi: c.factory.abi,
            event: c.factory.event,
            parameter: c.factory.parameter,
            startBlock: c.startBlock,
          };
          const spans = await classHistory(rpc, f.address, f.startBlock, classTo);
          if (spans.length === 0)
            throw new ConfigError(
              `${name}: factory ${f.address} is not deployed by block ${classTo}`,
            );
          return {
            ...f,
            reader: factoryReader(
              f,
              await Promise.all(
                spans.map(async (s) => ({ ...s, abi: await sources.abiOf(s.classHash) })),
              ),
            ),
          };
        })(),
      ];
    }),
  );
}
