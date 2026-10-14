import { createHash } from "node:crypto";
import { is } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgTable } from "drizzle-orm/pg-core";
import pg from "pg";
import { classHistory } from "./abi/history.ts";
import type { Route } from "./api/routes.ts";
import { Api, liveChannel } from "./api/server.ts";
import type { BlockConfig, Config, IndexedBlock, RunOptions } from "./app.ts";
import { EventCache } from "./cache.ts";
import { CallClient, type Client } from "./client.ts";
import { type Db, Store } from "./db/store.ts";
import { createTableSql, indexSql, quote, tableInfo } from "./db/table.ts";
import { RpcClient } from "./rpc/client.ts";
import { type Block, blockOf } from "./block.ts";
import { felt } from "./felt.ts";
import { blockNumber, type EmittedEvent, getHeaders } from "./rpc/methods.ts";
import { type Endpoint, probe } from "./rpc/probe.ts";
import { canonical, type FactorySource, factoryReader, Sources, upgradeEventsOf, type Watched } from "./sources.ts";
import { Status } from "./status.ts";
import { type Extras, fetchExtras } from "./sync/extras.ts";
import { type Batch, eventStream, type FetchGauges } from "./sync/fetch.ts";
import { HeadSubscription } from "./sync/heads.ts";
import { type BlockRef, findAncestor, follow, type LiveBlock } from "./sync/live.ts";

export type AnyHandler = (arg: { event: never; context: { db: Db; client: Client } }) => void | Promise<void>;

/** A child as its factory's creation event says: `address` (canonical), created by `contract`'s factory in `block`. */
type Child = { address: string; contract: string; block: number };

/** Where the run goes, fixed at startup from the config, `to` and the tip. */
export type Plan = {
  live: boolean;
  window: number;
  /** Final blocks: backfilled without a journal, cached. A `to` inside the reorg window stops at its edge. */
  backfillTo: number;
  /** Classes are known through here: the tip when following it (live blocks decode with the class active now). */
  classTo: number;
  /** The lowest start block: where indexing starts with nothing committed. */
  start: number;
  /** `to` was past `backfillTo`. */
  clamped: boolean;
};

export function planOf(config: Config, to: number | undefined, tip: number): Plan {
  const window = config.reorgWindow ?? 64;
  const backfillTo = to === undefined ? tip - window : Math.min(to, tip - window);
  const starts = [...Object.values(config.contracts), ...Object.values(config.blocks ?? {})].map((c) => c.startBlock);
  return { live: to === undefined, window, backfillTo, classTo: to === undefined ? tip : backfillTo, start: Math.min(...starts), clamped: to !== undefined && to > backfillTo };
}

/** Every transaction that moves the run. Nothing else writes the app's tables or `_kasbah_*` after startup. */
export type Commit =
  /** Factory pre-pass: the children created through `through`, resolved and not yet watched. Not a checkpoint. */
  | { kind: "children"; through: number; children: Watched[] }
  /** Backfill: final blocks through `through`, no journal. */
  | { kind: "batch"; through: number }
  /** Entering live: the block it starts from. */
  | { kind: "follow"; head: BlockRef }
  /** Live: one block, with its undo journal, its hash, and the children created in it (already watched). */
  | { kind: "block"; block: LiveBlock; children: Watched[] }
  /** Undoes every block after `to`. */
  | { kind: "revert"; to: BlockRef };

/**
 * What a commit moves: the transaction writes these to `_kasbah_meta` (a moved checkpoint also notifies the API),
 * and after COMMIT memory takes the same values. `watermark`: factory children are known through this block.
 */
export type Moves = { checkpoint?: number; watermark?: number; phase?: "backfill" | "live" };

export function moves(c: Commit, watermark: number): Moves {
  switch (c.kind) {
    case "children":
      return { watermark: Math.max(watermark, c.through), phase: "backfill" };
    case "batch":
      return { checkpoint: c.through, phase: "backfill" };
    case "follow":
      return { phase: "live" };
    case "block":
      return { checkpoint: c.block.number, watermark: c.block.number };
    case "revert":
      return c.to.number < watermark ? { checkpoint: c.to.number, watermark: c.to.number } : { checkpoint: c.to.number };
  }
}

/** Events (and block handlers) handled between two backfill commits. */
const FLUSH_EVENTS = 100_000;
const PHASES = ["factories", "backfill", "keys", "live"] as const;

/** Runs the app: setup, then each phase from where the database is. Reports only through `status`. */
export const DEFAULT_SCHEMA = "kasbah";

/** How the API is shown: listening on 127.0.0.1 unless told otherwise, shown as localhost, the same address. */
export const apiUrl = (api: { host?: string }, port: number) => `http://${api.host === undefined || api.host === "127.0.0.1" ? "localhost" : api.host}:${port}`;

export async function run(config: Config, handlers: ReadonlyMap<string, AnyHandler>, options: RunOptions = {}, routes: readonly Route[] = []): Promise<void> {
  const status = options.status ?? new Status();
  const unsubscribe = options.status === undefined ? status.subscribe((n) => console.log(`[kasbah] ${n.text}`)) : undefined;
  const signal = options.signal ?? new AbortController().signal;
  /** Opened resources, closed in reverse whatever happens. */
  const closers: (() => unknown)[] = [];
  let failure: { error: unknown } | undefined;
  try {
    const r = await Run.open(config, handlers, routes, options, status, signal, closers);
    for (const phase of PHASES) {
      if (signal.aborted) break;
      await r[phase]();
    }
  } catch (error) {
    failure = { error };
  }
  for (const close of closers.reverse()) {
    try {
      await close();
    } catch (error) {
      // Only when the run itself succeeded: never in place of its error.
      failure ??= { error };
    }
  }
  if (failure === undefined) status.enter("done");
  else status.fail(failure.error);
  unsubscribe?.();
  if (failure !== undefined) throw failure.error;
}

type Factory = FactorySource & { reader: ReturnType<typeof factoryReader> };
type Prefetched = { extras: Map<string, Extras>; headers: Map<number, Block> };
type BlockSource = BlockConfig & { name: string };

/** What the startup transaction read. */
type Stored = { checkpoint: number | undefined; discovered: Map<string, number>; known: Map<number, string>; children: Child[]; unkeyed: Set<string> };

/** What `open` builds; the phases use it and never replace any of it. */
type Setup = {
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
};

/**
 * One run. Phases hand nothing to each other but the committed position (`#checkpoint`, `#watermark`, `#known`):
 * each starts from it, so a phase with nothing left to do is a no-op. Only `#commit` moves it, after COMMIT.
 */
class Run {
  readonly #s: Setup;
  readonly #plan: Plan;
  readonly #client: CallClient;
  readonly #context: { db: Db; client: Client };
  readonly #factoryByAddress: Map<string, Factory>;
  readonly #factoryKeys: string[][];
  readonly #anyInclude: boolean;
  readonly #anyBlock: boolean;
  /** The last block committed (undefined: none yet). */
  #checkpoint: number | undefined;
  /** One for every factory: they always move together (a factory added later is another build). */
  #watermark: number;
  /** Hashes of indexed blocks inside the reorg window, by number (`follow` reads it by reference). */
  readonly #known: Map<number, string>;
  /** Blocks at or below this can't be reorged: backfill's end, then the head minus the reorg window. */
  #final: number;

  constructor(s: Setup, plan: Plan, stored: Stored) {
    this.#s = s;
    this.#plan = plan;
    this.#checkpoint = stored.checkpoint;
    this.#watermark = s.factories.length === 0 ? plan.start - 1 : Math.min(...s.factories.map((f) => stored.discovered.get(f.contract) ?? f.startBlock - 1));
    this.#known = stored.known;
    this.#final = plan.backfillTo;
    this.#client = new CallClient(s.rpc, { isFinal: (b) => b <= this.#final, cache: s.cache });
    this.#context = { db: s.store.db, client: this.#client };
    this.#factoryByAddress = new Map(s.factories.map((f) => [f.address, f]));
    this.#factoryKeys = [[...new Set(s.factories.flatMap((f) => f.reader.selectors))]];
    this.#anyInclude = Object.values(s.config.contracts).some((c) => c.include?.transaction || c.include?.receipt);
    this.#anyBlock = Object.values(s.config.contracts).some((c) => c.include?.block);
    s.status.checkpoint = this.#checkpoint ?? 0;
    s.status.calls = this.#client.stats;
    s.status.watched = () => ({ contracts: s.sources.addresses.length, children: s.sources.children });
  }

  /**
   * Validates the config, opens the database (refusing or dropping another build), the API, the RPC and the
   * cache, reads every class, then undoes a reorg that happened while stopped and watches the stored children.
   */
  static async open(config: Config, handlers: ReadonlyMap<string, AnyHandler>, routes: readonly Route[], options: RunOptions, status: Status, signal: AbortSignal, closers: (() => unknown)[]): Promise<Run> {
    const schema = config.schema ?? DEFAULT_SCHEMA;
    status.schema = schema;
    const blockSources = validate(config, handlers);
    const handledOf = (name: string) => new Set([...handlers.keys()].filter((h) => h.startsWith(`${name}:`)).map((h) => h.slice(name.length + 1)));
    const contracts = Object.entries(config.contracts).map(([name, c]) => ({ name, abi: c.abi, startBlock: c.startBlock, handled: handledOf(name), upgrades: upgradeEventsOf(name, c.abi, c.upgradeEvents) }));
    const tables = Object.values(config.tables).filter((t): t is PgTable => is(t, PgTable));
    // Built now, so an index kasbah can't create is refused before the backfill, not after it.
    const indexes = new Map(tables.map((t) => [t, indexSql(tableInfo(t))]));
    const pool = new pg.Pool({ connectionString: config.database, max: 8, options: `-c search_path=${quote(schema)}` });
    closers.push(() => pool.end());
    const buildId = buildIdOf(config, handlers, blockSources, tables, options.buildSalt);
    let reset = options.reset === true;
    if (!reset && options.onBuildChange === "reset") {
      const exists = (await pool.query(`SELECT to_regclass($1) AS r`, [`${quote(schema)}._kasbah_meta`])).rows[0].r !== null;
      const build = exists ? (await pool.query(`SELECT value FROM ${quote(schema)}._kasbah_meta WHERE key = 'build'`)).rows[0]?.value : undefined;
      if (build !== undefined && build !== buildId) {
        status.note({ kind: "rebuild" });
        reset = true;
      }
    }
    if (reset) await pool.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quote(schema)}`);
    const stored = await startup(pool, schema, tables, buildId);

    if (config.api !== undefined) {
      const api = await Api.start({ ...config.api, database: config.database, schema, tables: config.tables, routes });
      closers.push(() => api.close());
      status.api = apiUrl(config.api, api.port);
      status.note({ kind: "api", url: status.api });
    }
    const store = new Store(drizzle(pool), tables, { complete: stored.checkpoint === undefined, unkeyed: stored.unkeyed });
    const rpc = new RpcClient(config.rpc, { maxConcurrency: config.concurrency ?? 32 });
    const endpoint = await probe(rpc);
    const tip = await blockNumber(rpc);
    const plan = planOf(config, options.to, tip);
    if (plan.clamped && options.to !== undefined) status.note({ kind: "clamped", to: options.to, through: plan.backfillTo, tip, window: plan.window });
    const cache = config.cache
      ? await EventCache.open(pool, await rpc.request<string>("starknet_chainId", []), config.cache === true ? {} : config.cache)
      : undefined;
    const sources = new Sources(rpc, contracts, (n) => status.note(n));
    const factories = await factoriesOf(config, rpc, sources, plan.classTo);
    await Promise.all(Object.entries(config.contracts).flatMap(([name, c]) => (c.address === undefined ? [] : [sources.add(name, c.address, c.startBlock, plan.classTo, false)])));
    Object.assign(status, { endpoint: `${endpoint.node} ${endpoint.spec}`, tip, factories: factories.length, rpc: rpc.stats, rate: () => rpc.rate, cache: cache?.stats });
    status.note({ kind: "endpoint", node: endpoint.node, spec: endpoint.spec, tip, contracts: sources.addresses.length + stored.children.length, factories: factories.length, blockSources: blockSources.length });
    const r = new Run({ config, handlers, status, signal, closers, schema, pool, rpc, endpoint, cache, store, sources, factories, blockSources, tables, indexes }, plan, stored);
    await r.#resume(stored.children);
    return r;
  }

  /** The next block to index. */
  get #next(): number {
    return Math.max(this.#plan.start, (this.#checkpoint ?? -1) + 1);
  }

  /** Stopped while live: the blocks indexed last may have been reorged since (backfill trusts its start). */
  async #resume(children: Child[]): Promise<void> {
    const c = this.#checkpoint;
    const hash = c === undefined ? undefined : this.#known.get(c);
    if (c !== undefined && hash !== undefined) {
      const ancestor = await findAncestor(this.#s.rpc, c, this.#known);
      if (ancestor.number < c) await this.#reorg(ancestor, { number: c, hash }, true);
    }
    // Children found by earlier runs, minus those whose creation that reorg undid.
    const { sources } = this.#s;
    await Promise.all(children.filter((ch) => ch.block <= this.#watermark).map((ch) => sources.add(ch.contract, ch.address, ch.block, this.#plan.classTo, true)));
  }

  /** Every child created up to the backfill's end, before any child event is fetched: one commit. */
  async factories(): Promise<void> {
    const { factories, status, signal, cache, sources } = this.#s;
    const from = this.#watermark + 1;
    const to = this.#plan.backfillTo;
    if (factories.length === 0 || from > to) return;
    const started = performance.now();
    status.enter("factories");
    status.setRange(from, to, from - 1);
    const found = new Map<string, Child>();
    let through = from - 1;
    for await (const batch of this.#children(from, to, true)) {
      for (const c of batch.children) if (!found.has(c.address)) found.set(c.address, c);
      through = batch.through;
      status.range.through = through;
      if (signal.aborted) break;
    }
    const resolved = await Promise.all([...found.values()].map((c) => sources.resolve(c.contract, c.address, c.block, this.#plan.classTo, true)));
    const children = resolved.filter((w) => w !== undefined);
    await this.#commit({ kind: "children", through, children });
    cache?.untrack();
    status.note({ kind: "factories", children: children.length, through, seconds: (performance.now() - started) / 1000 });
  }

  /** Final blocks from the checkpoint to the backfill's end: a commit every FLUSH_EVENTS events or 64 MB of extras. */
  async backfill(): Promise<void> {
    const { status, sources, cache, signal } = this.#s;
    const first = this.#next;
    const to = this.#plan.backfillTo;
    if (first > to) return;
    const started = performance.now();
    status.enter("backfill");
    status.setRange(first, to, first - 1);
    const handledBefore = status.handled;
    let through = first - 1;
    let since = 0;
    const batches = this.#fetch(sources.addresses, sources.keys, first, to, true);
    // Headers, transactions and receipts of the next batch are fetched while this one is handled.
    const waited = (what: "events" | "extras", ms: number) => (what === "events" ? (status.time.fetch += ms) : (status.time.extras += ms));
    for await (const [batch, pre] of ahead(this.#anyInclude || this.#anyBlock ? slices(batches, 2_000) : batches, (b) => this.#prefetch(b.events), waited)) {
      since += await this.#handleBatch(through + 1, batch, pre);
      through = batch.through;
      status.range.through = through;
      if (signal.aborted) break;
      if (since >= FLUSH_EVENTS || through === to || (cache?.pendingBytes ?? 0) > 64 << 20) {
        await this.#commit({ kind: "batch", through });
        since = 0;
      }
    }
    if (!signal.aborted) through = to;
    // What was handled since the last commit: nothing when the last batch (through `to`) just committed.
    if (through !== (this.#checkpoint ?? first - 1)) await this.#commit({ kind: "batch", through });
    cache?.untrack();
    if (signal.aborted) return;
    const calls = this.#client.stats;
    const c = cache?.stats;
    status.note({ kind: "backfill", handled: status.handled - handledBefore, seconds: (performance.now() - started) / 1000, cache: c && { ...c }, reads: calls.calls, cachedReads: calls.cached, rpc: status.rpc && { calls: status.rpc.calls, throttled: status.rpc.throttled, rate: status.rate() } });
  }

  /** Primary keys and indexes, a transaction per table in parallel: each table is locked only while its own are built. */
  async keys(): Promise<void> {
    const { status, store, tables, indexes, pool } = this.#s;
    const started = performance.now();
    const count = [...indexes.values()].reduce((n, l) => n + l.length, 0);
    status.enter("keys");
    status.keys = { tables: store.unkeyed, indexes: count };
    const built = await Promise.all(tables.map((t) => transaction(pool, async (tx) => {
      const keyed = await store.addKey(t, tx);
      for (const statement of indexes.get(t)!) await tx.query(statement);
      return keyed;
    })));
    const seconds = (performance.now() - started) / 1000;
    const keys = built.filter(Boolean).length;
    if (keys > 0 || seconds >= 1) status.note({ kind: "keys", keys, indexes: count, seconds });
  }

  /** Follows the head: a commit per block, with its undo journal, until the signal aborts. */
  async live(): Promise<void> {
    if (!this.#plan.live) return;
    const { config, rpc, endpoint, sources, status, store, signal, closers } = this.#s;
    const last = this.#next - 1;
    const head = { number: last, hash: this.#known.get(last) ?? (await getHeaders(rpc, [last], 1))[0]!.block_hash };
    await this.#commit({ kind: "follow", head });
    store.journal = true;
    status.enter("live");
    status.live.block = last;
    status.note({ kind: "following", block: last });
    const pollMs = config.pollMs ?? 2_000;
    const heads = config.ws === undefined ? undefined : new HeadSubscription(config.ws === true ? config.rpc.replace(/^http/, "ws") : config.ws, (n) => status.note(n));
    if (heads !== undefined) {
      closers.push(() => heads.close());
      status.head = () => heads.last;
    }
    /** Children created in the blocks of the current tick, by block: committed with their block. */
    let children = new Map<number, Watched[]>();
    await follow({
      rpc, address: sources.addresses, keys: sources.keys, chunkSize: endpoint.maxChunk, head, known: this.#known, signal, pollMs,
      // With a socket up, a missed head costs at most 15 s; without, poll as usual.
      wait: heads === undefined ? undefined : (s) => heads.wait(heads.healthy ? Math.max(pollMs, 15_000) : pollMs, s),
      prepare: async (from, to) => {
        children = await this.#discover(from, to);
        await sources.checkClasses(from, to);
      },
      onBlock: (block) => this.#block(block, children.get(block.number) ?? []),
      onReorg: (ancestor, replaced) => this.#reorg(ancestor, replaced, false),
    });
  }

  async #block(block: LiveBlock, children: Watched[]): Promise<void> {
    this.#final = Math.max(this.#final, block.number - this.#plan.window);
    await this.#s.sources.upgradesIn(block.events, block.number);
    const extras = await this.#extras(block.events);
    const headers = new Map([[block.number, block.header]]);
    for (const e of block.events) await this.#handle(e, extras, headers);
    for (const b of this.#s.blockSources) if (firesAt(b, block.number)) await this.#fire(b.name, block.header);
    await this.#commit({ kind: "block", block, children });
  }

  async #reorg(ancestor: BlockRef, replaced: BlockRef, stopped: boolean): Promise<void> {
    const { undone, forgotten } = await this.#commit({ kind: "revert", to: ancestor });
    this.#s.status.note({ kind: "reorg", block: replaced.number, hash: felt(replaced.hash), ancestor: ancestor.number, rows: undone, children: forgotten, stopped });
  }

  /**
   * Live, before blocks `from..to` are fetched: watches the children created in them at once (their events come in
   * the same fetch) and returns them by block, for the blocks' commits. Children of a tick that never committed (a
   * reorg, a lagging node) are dropped first.
   */
  async #discover(from: number, to: number): Promise<Map<number, Watched[]>> {
    const { sources, factories } = this.#s;
    sources.removeChildrenAfter(from - 1);
    const byBlock = new Map<number, Watched[]>();
    if (factories.length === 0) return byBlock;
    for await (const batch of this.#children(from, to, false)) {
      for (const c of batch.children) {
        const w = await sources.add(c.contract, c.address, c.block, to, true);
        if (w !== undefined) byBlock.set(c.block, [...(byBlock.get(c.block) ?? []), w]);
      }
    }
    return byBlock;
  }

  /** The children the factories created in `[from, to]`, batch by batch. The one decoder of creation events. */
  async *#children(from: number, to: number, final: boolean): AsyncGenerator<{ through: number; children: Child[] }> {
    for await (const batch of this.#fetch(this.#s.factories.map((f) => f.address), this.#factoryKeys, from, to, final)) {
      const children: Child[] = [];
      for (const e of batch.events) {
        const f = this.#factoryByAddress.get(canonical(e.from_address));
        if (f === undefined || e.block_number! < f.startBlock) continue;
        const address = f.reader.child(e);
        if (address !== undefined) children.push({ address, contract: f.contract, block: e.block_number! });
      }
      yield { through: batch.through, children };
    }
  }

  /**
   * Ordered batches of `addresses` × `keys` in `[from, to]`. Final ranges: the cached prefix first, then RPC, tracked
   * for the cache (the phase calls `cache.untrack` after its last commit). Live ranges: RPC only.
   */
  async *#fetch(addresses: string[], keys: string[][], from: number, to: number, final: boolean): AsyncGenerator<Batch> {
    const { rpc, endpoint, config } = this.#s;
    const cache = final ? this.#s.cache : undefined;
    if (addresses.length === 0 || keys[0]!.length === 0) {
      for (let lo = from; lo <= to; lo += 100_000) yield { events: [], through: Math.min(to, lo + 99_999) };
      return;
    }
    let start = from;
    if (cache !== undefined) {
      const end = Math.min(to, (await cache.coveredUntil(addresses, keys[0]!, from)) - 1);
      if (end >= from) {
        yield* cache.read(addresses, keys[0]!, from, end);
        start = end + 1;
      }
      if (start <= to) cache.track(addresses, keys[0]!, start);
    }
    if (start > to) return;
    const gauges = (read: () => FetchGauges) => (this.#s.status.fetcher = read);
    for await (const batch of eventStream({ rpc, address: addresses, keys, from: start, to, chunkSize: endpoint.maxChunk, concurrency: config.concurrency ?? 32, gauges })) {
      cache?.add(batch.events);
      yield batch;
    }
    this.#s.status.fetcher = undefined;
  }

  /** Handles one backfill batch: events and the block handlers due in `[from, batch.through]`, in block order. Returns how many. */
  async #handleBatch(from: number, batch: Batch, { extras, headers }: Prefetched): Promise<number> {
    const fires = firesIn(this.#s.blockSources, from, batch.through);
    const missing = fires.map((f) => f.number).filter((n) => !headers.has(n));
    if (missing.length > 0) for (const [n, h] of await this.#headers(missing)) headers.set(n, h);
    let i = 0;
    const fireUntil = async (block: number) => {
      for (; i < fires.length && fires[i]!.number < block; i++) {
        await this.#fire(fires[i]!.source, headers.get(fires[i]!.number)!);
      }
    };
    for (const e of batch.events) {
      await fireUntil(e.block_number!);
      await this.#handle(e, extras, headers);
    }
    await fireUntil(batch.through + 1);
    return batch.events.length + fires.length;
  }

  #watchedOf(e: EmittedEvent) {
    const { byAddress } = this.#s.sources;
    return byAddress.get(e.from_address) ?? byAddress.get(canonical(e.from_address));
  }

  /** What a batch's handlers need besides its events: transactions, receipts, and headers for `include.block`. */
  async #prefetch(events: EmittedEvent[]): Promise<Prefetched> {
    const blocks = this.#anyBlock ? events.filter((e) => this.#includeOf(e)?.block).map((e) => e.block_number!) : [];
    const [extras, headers] = await Promise.all([this.#extras(events), blocks.length > 0 ? this.#headers(blocks) : new Map<number, Block>()]);
    return { extras, headers };
  }

  #includeOf(e: EmittedEvent) {
    const w = this.#watchedOf(e);
    return w === undefined ? undefined : this.#s.config.contracts[w.contract]!.include;
  }

  #extras(events: EmittedEvent[]): Promise<Map<string, Extras>> {
    if (!this.#anyInclude) return Promise.resolve(new Map());
    return fetchExtras(this.#s.rpc, events, (e) => this.#includeOf(e), { cache: this.#s.cache, isFinal: (b) => b <= this.#final });
  }

  /** Decodes `e` with its address's class at that block and runs its handler, if any. */
  async #handle(e: EmittedEvent, extras: Map<string, Extras>, headers: Map<number, Block>): Promise<void> {
    const w = this.#watchedOf(e);
    if (w === undefined || e.block_number! < w.from) return;
    const decoded = w.decode(e.block_number!, e.keys, e.data);
    if (decoded === undefined) return;
    const name = `${w.contract}:${decoded.name}`;
    const handler = this.#s.handlers.get(name);
    if (handler === undefined) return;
    const x = extras.get(e.transaction_hash);
    const event = {
      contract: w.contract,
      name: decoded.name,
      args: decoded.args,
      address: felt(e.from_address),
      block: this.#s.config.contracts[w.contract]!.include?.block
        ? headers.get(e.block_number!)!
        : { number: e.block_number!, hash: e.block_hash === undefined ? undefined : felt(e.block_hash) },
      transaction: { ...x?.transaction, hash: felt(e.transaction_hash), index: e.transaction_index },
      // Padded only if a handler reads it.
      get log() {
        return { keys: e.keys.map(felt), data: e.data.map(felt) };
      },
      ...(x?.receipt === undefined ? {} : { receipt: x.receipt }),
      index: e.event_index,
    };
    this.#client.current = event.block;
    const t = performance.now();
    try {
      await handler({ event: event as never, context: this.#context });
    } catch (err) {
      throw new Error(`${name} at block ${e.block_number}, tx ${e.transaction_hash}: ${(err as Error).message}`, { cause: err });
    }
    this.#s.status.record(name, performance.now() - t);
  }

  async #fire(source: string, block: IndexedBlock["block"]): Promise<void> {
    const handler = this.#s.handlers.get(`${source}:block`);
    if (handler === undefined) return;
    this.#client.current = block;
    const t = performance.now();
    try {
      await handler({ event: { source, block } as never, context: this.#context });
    } catch (err) {
      throw new Error(`${source}:block at block ${block.number}: ${(err as Error).message}`, { cause: err });
    }
    this.#s.status.record(`${source}:block`, performance.now() - t);
  }

  /** Headers for block handlers: the cache's, then RPC (final ones saved to the shared cache, outside any commit). */
  async #headers(numbers: number[]): Promise<Map<number, Block>> {
    const { cache, rpc } = this.#s;
    const unique = [...new Set(numbers)];
    const found = (await cache?.headers(unique)) ?? new Map<number, Block>();
    const fetched = await getHeaders(rpc, unique.filter((n) => !found.has(n)), 100);
    await cache?.saveHeaders(fetched.filter((h) => h.block_number <= this.#plan.backfillTo));
    for (const h of fetched) found.set(h.block_number, blockOf(h));
    return found;
  }

  /**
   * The one way the run writes: a transaction per `Commit`, then, after COMMIT, memory follows (the position, the
   * watched children, known hashes) and `status.committed`. Store and cache drain their buffers into the
   * transaction; a failed commit fails the run, so nothing retries against them.
   */
  async #commit(c: Commit): Promise<{ undone: number; forgotten: number }> {
    const { pool, store, cache, factories, sources, status, schema } = this.#s;
    const { window } = this.#plan;
    const m = moves(c, this.#watermark);
    const parts = { tables: 0, cache: 0 };
    const timed = async (part: keyof typeof parts, write: () => unknown) => {
      const t = performance.now();
      await write();
      parts[part] += performance.now() - t;
    };
    let undone = 0;
    const started = performance.now();
    await transaction(pool, async (tx) => {
      switch (c.kind) {
        case "children":
          await timed("cache", () => cache?.persist(tx, c.through));
          await insertChildren(tx, c.children);
          break;
        case "batch":
          await timed("tables", () => store.flush(tx));
          await timed("cache", () => cache?.persist(tx, c.through));
          break;
        case "follow":
          await saveHash(tx, c.head);
          break;
        case "block": {
          const n = c.block.number;
          await timed("tables", () => store.flush(tx, n));
          await timed("cache", () => cache?.persist(tx, -1));
          await insertChildren(tx, c.children);
          await saveHash(tx, c.block);
          await tx.query(`DELETE FROM _kasbah_blocks WHERE number < $1`, [n - window]);
          await tx.query(`DELETE FROM _kasbah_journal WHERE block < $1`, [n - window]);
          break;
        }
        case "revert":
          await timed("tables", async () => (undone = await store.revert(tx, c.to.number)));
          await tx.query(`DELETE FROM _kasbah_blocks WHERE number > $1`, [c.to.number]);
          await tx.query(`DELETE FROM _kasbah_children WHERE block > $1`, [c.to.number]);
          break;
      }
      if (m.watermark !== undefined) for (const f of factories) await setMeta(tx, `discovered:${f.contract}`, m.watermark);
      if (m.phase !== undefined) await setMeta(tx, "phase", m.phase);
      if (m.checkpoint !== undefined) {
        await setMeta(tx, "checkpoint", m.checkpoint);
        // Delivered at COMMIT: API servers re-run live queries.
        await tx.query(`SELECT pg_notify($1, $2)`, [liveChannel(schema), JSON.stringify({ checkpoint: m.checkpoint })]);
      }
    });
    const ms = performance.now() - started;
    if (m.checkpoint !== undefined) this.#checkpoint = m.checkpoint;
    if (m.watermark !== undefined) this.#watermark = m.watermark;
    let forgotten = 0;
    switch (c.kind) {
      case "children":
        for (const w of c.children) sources.watch(w);
        break;
      case "follow":
        this.#known.set(c.head.number, c.head.hash);
        break;
      case "block":
        this.#known.set(c.block.number, c.block.hash);
        for (const n of this.#known.keys()) if (n < c.block.number - window) this.#known.delete(n);
        break;
      case "revert":
        forgotten = sources.removeChildrenAfter(c.to.number).length;
        for (const n of this.#known.keys()) if (n > c.to.number) this.#known.delete(n);
        break;
    }
    const block = c.kind === "block" ? { number: c.block.number, timestamp: c.block.header.timestamp, events: c.block.events.length, children: c.children.length } : undefined;
    status.committed({ kind: c.kind, ms, ...parts, checkpoint: this.#checkpoint, block });
    return { undone, forgotten };
  }
}

async function transaction<T>(pool: pg.Pool, body: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const tx = await pool.connect();
  let out: T;
  try {
    await tx.query("BEGIN");
    out = await body(tx);
    await tx.query("COMMIT");
  } catch (err) {
    // A failed ROLLBACK leaves the connection unusable: dropped, and the original error kept.
    await tx.query("ROLLBACK").then(() => tx.release(), (e) => tx.release(e));
    throw err;
  }
  tx.release();
  return out;
}

const setMeta = (tx: pg.PoolClient, key: string, value: unknown) =>
  tx.query(`INSERT INTO _kasbah_meta VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, JSON.stringify(value)]);

const saveHash = (tx: pg.PoolClient, block: BlockRef) =>
  tx.query(`INSERT INTO _kasbah_blocks VALUES ($1, $2) ON CONFLICT (number) DO UPDATE SET hash = EXCLUDED.hash`, [block.number, block.hash]);

const insertChildren = async (tx: pg.PoolClient, children: Watched[]) => {
  for (const w of children) await tx.query(`INSERT INTO _kasbah_children VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [w.address, w.contract, w.from]);
};

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
    if (config.contracts[b.name] !== undefined) throw new Error(`${b.name} is both a contract and a block source`);
    if (!(b.interval >= 1)) throw new Error(`${b.name}: interval must be at least 1`);
  }
  for (const h of handlers.keys()) {
    const [source] = h.split(":");
    if (config.contracts[source!] === undefined && config.blocks?.[source!] === undefined) throw new Error(`handler ${h}: no contract or block source ${source}`);
  }
  return blockSources;
}

function buildIdOf(config: Config, handlers: ReadonlyMap<string, AnyHandler>, blockSources: BlockSource[], tables: PgTable[], salt: string | undefined): string {
  return createHash("sha256")
    .update(JSON.stringify({
      contracts: Object.entries(config.contracts).map(([k, c]) => [
        k,
        c.address === undefined ? [canonical(c.factory.address), c.factory.event, c.factory.parameter] : canonical(c.address),
        c.startBlock,
      ]),
      blocks: blockSources.map((b) => [b.name, b.interval, b.startBlock, b.endBlock ?? null]),
      tables: tables.map((t) => createTableSql(tableInfo(t))),
      // Their code too: a changed handler means the stored results are stale.
      handlers: [...handlers].map(([name, h]) => [name, h.toString()]).sort(),
      source: salt ?? null,
    }))
    .digest("hex")
    .slice(0, 16);
}

const numberOf = (v: unknown) => (typeof v === "number" ? v : undefined);

/** The startup transaction: `_kasbah_*` tables, the build check, app tables without keys, and what earlier runs stored. */
function startup(pool: pg.Pool, schema: string, tables: PgTable[], buildId: string): Promise<Stored> {
  return transaction(pool, async (tx) => {
    for (const sql of META_SQL) await tx.query(sql);
    const meta = new Map((await tx.query<{ key: string; value: unknown }>(`SELECT key, value FROM _kasbah_meta`)).rows.map((r) => [r.key, r.value]));
    const build = meta.get("build");
    if (build !== undefined && build !== buildId) throw new Error(`schema "${schema}" holds another build of this app (config, tables or handlers changed); run with reset`);
    // Keys and indexes come once the backfill is done, or when the store first needs a key.
    for (const t of tables) await tx.query(createTableSql(tableInfo(t), { primaryKey: false }));
    const missing = await tx.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c
       WHERE c.relnamespace = $1::regnamespace AND c.relname = ANY($2) AND NOT EXISTS (SELECT 1 FROM pg_constraint p WHERE p.conrelid = c.oid AND p.contype = 'p')`,
      [quote(schema), tables.map((t) => tableInfo(t).name)],
    );
    await tx.query(`INSERT INTO _kasbah_meta VALUES ('build', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify(buildId)]);
    const discovered = new Map<string, number>();
    for (const [k, v] of meta) if (k.startsWith("discovered:") && typeof v === "number") discovered.set(k.slice("discovered:".length), v);
    return {
      checkpoint: numberOf(meta.get("checkpoint")),
      discovered,
      known: new Map((await tx.query<BlockRef>(`SELECT number, hash FROM _kasbah_blocks`)).rows.map((b) => [b.number, b.hash])),
      children: (await tx.query<Child>(`SELECT address, contract, block FROM _kasbah_children ORDER BY block`)).rows,
      unkeyed: new Set(missing.rows.map((r) => r.name)),
    };
  });
}

function factoriesOf(config: Config, rpc: RpcClient, sources: Sources, classTo: number): Promise<Factory[]> {
  return Promise.all(Object.entries(config.contracts).flatMap(([name, c]) => {
    if (c.factory === undefined) return [];
    return [(async () => {
      const f: FactorySource = { contract: name, address: canonical(c.factory.address), abi: c.factory.abi, event: c.factory.event, parameter: c.factory.parameter, startBlock: c.startBlock };
      const spans = await classHistory(rpc, f.address, f.startBlock, classTo);
      if (spans.length === 0) throw new Error(`${name}: factory ${f.address} is not deployed by block ${classTo}`);
      return { ...f, reader: factoryReader(f, await Promise.all(spans.map(async (s) => ({ ...s, abi: await sources.abiOf(s.classHash) })))) };
    })()];
  }));
}

const firesAt = (b: BlockSource, n: number) => n >= b.startBlock && (b.endBlock === undefined || n <= b.endBlock) && (n - b.startBlock) % b.interval === 0;

/** Block handlers due in `[from, to]`, in block order. */
function firesIn(blockSources: BlockSource[], from: number, to: number): { source: string; number: number }[] {
  const out: { source: string; number: number }[] = [];
  for (const b of blockSources) {
    const lo = Math.max(from, b.startBlock);
    const hi = Math.min(to, b.endBlock ?? to);
    for (let n = b.startBlock + Math.ceil((lo - b.startBlock) / b.interval) * b.interval; n <= hi; n += b.interval) out.push({ source: b.name, number: n });
  }
  return out.sort((x, y) => x.number - y.number);
}

/**
 * Cuts batches into slices of about `max` events, always at a block boundary (a checkpoint never falls inside a
 * block). Keeps memory small when every event brings its transaction and receipt.
 */
async function* slices(source: AsyncIterable<Batch>, max: number): AsyncGenerator<Batch> {
  for await (const batch of source) {
    let start = 0;
    while (batch.events.length - start > max) {
      let end = start + max;
      const block = batch.events[end - 1]!.block_number!;
      while (end < batch.events.length && batch.events[end]!.block_number === block) end++;
      if (end === batch.events.length) break;
      yield { events: batch.events.slice(start, end), through: batch.events[end]!.block_number! - 1 };
      start = end;
    }
    yield { events: start === 0 ? batch.events : batch.events.slice(start), through: batch.through };
  }
}

/**
 * Yields each item with `prepare(item)`, preparing the next item while the caller handles this one. `waited` gets
 * the time the caller waited for the source and, after that, for `prepare`.
 */
async function* ahead<T, U>(source: AsyncIterable<T>, prepare: (item: T) => Promise<U>, waited: (what: "events" | "extras", ms: number) => void): AsyncGenerator<[T, U]> {
  let pending: Promise<[T, U]> | undefined;
  let t = performance.now();
  const ready = async (p: Promise<[T, U]>) => {
    const r = await p;
    const now = performance.now();
    waited("extras", now - t);
    return r;
  };
  for await (const item of source) {
    const now = performance.now();
    waited("events", now - t);
    t = now;
    const next = prepare(item).then((u): [T, U] => [item, u]);
    next.catch(() => {});
    if (pending !== undefined) {
      yield await ready(pending);
      t = performance.now();
    }
    pending = next;
  }
  if (pending !== undefined) yield await ready(pending);
}

