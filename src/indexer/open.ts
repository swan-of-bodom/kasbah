import { createHash } from "node:crypto";
import { is } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgTable } from "drizzle-orm/pg-core";
import pg from "pg";
import { classHistory } from "../abi/history.ts";
import type { Route } from "../api/routes.ts";
import { Api } from "../api/server.ts";
import type { BlockConfig, Config, RunOptions } from "../config/app.ts";
import { ConfigError } from "../config/errors.ts";
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
import { resume } from "./phases/live.ts";
import { type Plan, planOf } from "./plan.ts";
import type { AnyHandler } from "./run.ts";
import { type FactorySource, factoryReader, Sources, upgradeEventsOf } from "./sources.ts";
import type { Status } from "./status.ts";

export const DEFAULT_SCHEMA = "kasbah";

/** How the API is shown: listening on 127.0.0.1 unless told otherwise, shown as localhost, the same address. */
export const apiUrl = (api: { host?: string }, port: number) =>
  `http://${api.host === undefined || api.host === "127.0.0.1" ? "localhost" : api.host}:${port}`;

export type Factory = FactorySource & { reader: ReturnType<typeof factoryReader> };
export type BlockSource = BlockConfig & { name: string };

/** What `open` builds and every phase reads. Only `position` (through its commit) and `final` ever change. */
export type Run = {
  config: Config;
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
  /** Blocks at or below this can't be reorged: backfill's end, then the head minus the reorg window. */
  final: number;
  client: CallClient;
  context: { db: Db; client: Client };
  /** Some contract includes transactions or receipts. */
  anyInclude: boolean;
  /** Some contract includes the block header. */
  anyBlock: boolean;
};

/** What the startup transaction read. */
type Stored = {
  checkpoint: number | undefined;
  discovered: Map<string, number>;
  known: Map<number, string>;
  children: Child[];
  unkeyed: Set<string>;
};

/**
 * Validates the config, opens the database (refusing or dropping another build), the API, the RPC and the
 * cache, reads every class, then undoes a reorg that happened while stopped and watches the stored children.
 */
export async function open(
  config: Config,
  handlers: ReadonlyMap<string, AnyHandler>,
  routes: readonly Route[],
  options: RunOptions,
  status: Status,
  signal: AbortSignal,
  closers: (() => unknown)[],
): Promise<Run> {
  const schema = config.schema ?? DEFAULT_SCHEMA;
  status.schema = schema;
  const blockSources = validate(config, handlers);
  const handledOf = (name: string) =>
    new Set(
      [...handlers.keys()]
        .filter((h) => h.startsWith(`${name}:`))
        .map((h) => h.slice(name.length + 1)),
    );
  const contracts = Object.entries(config.contracts).map(([name, c]) => ({
    name,
    abi: c.abi,
    startBlock: c.startBlock,
    handled: handledOf(name),
    upgrades: upgradeEventsOf(name, c.abi, c.upgradeEvents),
  }));
  const tables = Object.values(config.tables).filter((t): t is PgTable => is(t, PgTable));
  // Built now, so an index kasbah can't create is refused before the backfill, not after it.
  const indexes = new Map(tables.map((t) => [t, indexSql(tableInfo(t))]));
  const pool = new pg.Pool({
    connectionString: config.database,
    max: 8,
    options: `-c search_path=${quote(schema)}`,
  });
  closers.push(() => pool.end());
  const buildId = buildIdOf(config, handlers, blockSources, tables, options.buildSalt);
  let reset = options.reset === true;
  if (!reset && options.onBuildChange === "reset") {
    const exists =
      (await pool.query(`SELECT to_regclass($1) AS r`, [`${quote(schema)}._kasbah_meta`])).rows[0]
        .r !== null;
    const build = exists
      ? (await pool.query(`SELECT value FROM ${quote(schema)}._kasbah_meta WHERE key = 'build'`))
          .rows[0]?.value
      : undefined;
    if (build !== undefined && build !== buildId) {
      status.note({ kind: "rebuild" });
      reset = true;
    }
  }
  if (reset) await pool.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quote(schema)}`);
  const stored = await startup(pool, schema, tables, buildId);

  if (config.api !== undefined) {
    const api = await Api.start({
      ...config.api,
      database: config.database,
      schema,
      tables: config.tables,
      routes,
    });
    closers.push(() => api.close());
    status.api = apiUrl(config.api, api.port);
    status.note({ kind: "api", url: status.api });
  }
  const store = new Store(drizzle(pool), tables, {
    complete: stored.checkpoint === undefined,
    unkeyed: stored.unkeyed,
  });
  const rpc = new RpcClient(config.rpc, { maxConcurrency: config.concurrency ?? 32 });
  const endpoint = await probe(rpc);
  const tip = await blockNumber(rpc);
  const plan = planOf(config, options.to, tip);
  if (plan.clamped && options.to !== undefined)
    status.note({
      kind: "clamped",
      to: options.to,
      through: plan.backfillTo,
      tip,
      window: plan.window,
    });
  const cache = config.cache
    ? await EventCache.open(
        pool,
        await rpc.request<string>("starknet_chainId", []),
        config.cache === true ? {} : config.cache,
      )
    : undefined;
  const sources = new Sources(rpc, contracts, (n) => status.note(n));
  const factories = await factoriesOf(config, rpc, sources, plan.classTo);
  await Promise.all(
    Object.entries(config.contracts).flatMap(([name, c]) =>
      c.address === undefined
        ? []
        : [sources.add(name, c.address, c.startBlock, plan.classTo, false)],
    ),
  );
  Object.assign(status, {
    endpoint: `${endpoint.node} ${endpoint.spec}`,
    tip,
    factories: factories.length,
    rpc: rpc.stats,
    rate: () => rpc.rate,
    cache: cache?.stats,
  });
  status.note({
    kind: "endpoint",
    node: endpoint.node,
    spec: endpoint.spec,
    tip,
    contracts: sources.addresses.length + stored.children.length,
    factories: factories.length,
    blockSources: blockSources.length,
  });

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
      window: plan.window,
      start: plan.start,
    },
    { checkpoint: stored.checkpoint, watermark, known: stored.known },
  );
  const anyInclude = Object.values(config.contracts).some(
    (c) => c.include?.transaction || c.include?.receipt,
  );
  const anyBlock = Object.values(config.contracts).some((c) => c.include?.block);
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
    final: plan.backfillTo,
    anyInclude,
    anyBlock,
  };
  const client = new CallClient(rpc, { isFinal: (b) => b <= partial.final, cache });
  const run: Run = Object.assign(partial, { client, context: { db: store.db, client } });
  status.checkpoint = position.checkpoint ?? 0;
  status.calls = client.stats;
  status.watched = () => ({ contracts: sources.addresses.length, children: sources.children });
  await resume(run, stored.children);
  return run;
}

const META_SQL = [
  `CREATE TABLE IF NOT EXISTS _kasbah_meta (key text PRIMARY KEY, value jsonb NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS _kasbah_blocks (number integer PRIMARY KEY, hash text NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS _kasbah_journal (block integer NOT NULL, seq bigserial, tbl text NOT NULL, pk jsonb NOT NULL, before jsonb)`,
  `CREATE INDEX IF NOT EXISTS _kasbah_journal_block ON _kasbah_journal (block)`,
  `CREATE TABLE IF NOT EXISTS _kasbah_children (address text PRIMARY KEY, contract text NOT NULL, block integer NOT NULL)`,
];

/** The block sources, after checking every source and handler name. */
function validate(config: Config, handlers: ReadonlyMap<string, AnyHandler>): BlockSource[] {
  const blockSources = Object.entries(config.blocks ?? {}).map(([name, b]) => ({ name, ...b }));
  for (const b of blockSources) {
    if (config.contracts[b.name] !== undefined)
      throw new ConfigError(`${b.name} is both a contract and a block source`);
    if (!(b.interval >= 1)) throw new ConfigError(`${b.name}: interval must be at least 1`);
  }
  for (const h of handlers.keys()) {
    const [source] = h.split(":");
    if (config.contracts[source!] === undefined && config.blocks?.[source!] === undefined)
      throw new ConfigError(`handler ${h}: no contract or block source ${source}`);
  }
  return blockSources;
}

function buildIdOf(
  config: Config,
  handlers: ReadonlyMap<string, AnyHandler>,
  blockSources: BlockSource[],
  tables: PgTable[],
  salt: string | undefined,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        contracts: Object.entries(config.contracts).map(([k, c]) => [
          k,
          c.address === undefined
            ? [canonical(c.factory.address), c.factory.event, c.factory.parameter]
            : canonical(c.address),
          c.startBlock,
        ]),
        blocks: blockSources.map((b) => [b.name, b.interval, b.startBlock, b.endBlock ?? null]),
        tables: tables.map((t) => createTableSql(tableInfo(t))),
        // Their code too: a changed handler means the stored results are stale.
        handlers: [...handlers].map(([name, h]) => [name, h.toString()]).sort(),
        source: salt ?? null,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

const numberOf = (v: unknown) => (typeof v === "number" ? v : undefined);

/** The startup transaction: `_kasbah_*` tables, the build check, app tables without keys, and what earlier runs stored. */
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
  config: Config,
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
