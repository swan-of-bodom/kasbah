import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { is, type Relations } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import pg from "pg";
import type { Abi } from "./abi/abi.ts";
import { classHistory } from "./abi/history.ts";
import type { EventArgs, EventName } from "./abi/types.ts";
import { Api, liveChannel } from "./api/server.ts";
import { EventCache } from "./cache.ts";
import { CallClient, type Client } from "./client.ts";
import { Store, type Db } from "./db/store.ts";
import { createTableSql, quote, tableInfo } from "./db/table.ts";
import { RpcClient } from "./rpc/client.ts";
import { blockNumber, type EmittedEvent, getEvents, getHeaders } from "./rpc/methods.ts";
import { probe } from "./rpc/probe.ts";
import { canonical, type FactorySource, factoryReader, Sources } from "./sources.ts";
import { type Batch, eventStream } from "./sync/fetch.ts";
import { HeadSubscription } from "./sync/heads.ts";
import { type BlockRef, findAncestor, follow } from "./sync/live.ts";

/** Children are the `parameter` (an address) of every `event` the factory at `address` emits. */
export type FactoryConfig = { address: string; abi: Abi; event: string; parameter: string };

export type ContractConfig = { abi: Abi; startBlock: number } & ({ address: string; factory?: undefined } | { factory: FactoryConfig; address?: undefined });

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
  /** Serve the read API (SQL over HTTP, GraphQL) while indexing. */
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

export type IndexedBlock<K extends string = string> = { source: K; block: { number: number; hash: string; timestamp: number } };

export type IndexedEvent<C extends Config, N extends HandlerName<C>> = N extends `${infer K}:${infer E}`
  ? K extends keyof Contracts<C> & string
    ? E extends EventName<Contracts<C>[K]["abi"]>
      ? {
          contract: K;
          name: E;
          args: EventArgs<Contracts<C>[K]["abi"], E>;
          address: `0x${string}`;
          block: { number: number; hash: string | undefined };
          transaction: { hash: string; index: number };
          /** Position of the event in its transaction. */
          index: number;
        }
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
  signal?: AbortSignal;
  log?: (line: string) => void;
};

const paddedCache = new Map<string, `0x${string}`>();
const padded = (address: string) => {
  let p = paddedCache.get(address);
  if (p === undefined) {
    p = `0x${BigInt(address).toString(16).padStart(64, "0")}` as `0x${string}`;
    if (paddedCache.size < 100_000) paddedCache.set(address, p);
  }
  return p;
};

/** Events (and block handlers) handled between two database transactions during backfill. */
const FLUSH_EVENTS = 100_000;

const META_SQL = [
  `CREATE TABLE IF NOT EXISTS _kasbah_meta (key text PRIMARY KEY, value jsonb NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS _kasbah_blocks (number integer PRIMARY KEY, hash text NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS _kasbah_journal (block integer NOT NULL, seq bigserial, tbl text NOT NULL, pk jsonb NOT NULL, before jsonb)`,
  `CREATE INDEX IF NOT EXISTS _kasbah_journal_block ON _kasbah_journal (block)`,
  `CREATE TABLE IF NOT EXISTS _kasbah_children (address text PRIMARY KEY, contract text NOT NULL, block integer NOT NULL)`,
];

export function kasbah<const C extends Config>(config: C) {
  const handlers = new Map<string, Handler<C, HandlerName<C>>>();

  const on = <N extends HandlerName<C>>(name: N, handler: Handler<C, N>) => {
    if (handlers.has(name)) throw new Error(`${name} already has a handler`);
    handlers.set(name, handler as never);
  };

  const run = async (options: RunOptions = {}) => {
    const log = options.log ?? ((line: string) => console.log(`[kasbah] ${line}`));
    const signal = options.signal ?? new AbortController().signal;
    const schema = config.schema ?? "kasbah";
    const window = config.reorgWindow ?? 64;
    const tables = Object.values(config.tables).filter((t): t is PgTable => is(t, PgTable));
    const blockSources = Object.entries(config.blocks ?? {}).map(([name, b]) => ({ name, ...b }));
    for (const b of blockSources) {
      if (config.contracts[b.name] !== undefined) throw new Error(`${b.name} is both a contract and a block source`);
      if (!(b.interval >= 1)) throw new Error(`${b.name}: interval must be at least 1`);
    }
    for (const h of handlers.keys()) {
      const [source] = h.split(":");
      if (config.contracts[source!] === undefined && config.blocks?.[source!] === undefined) throw new Error(`handler ${h}: no contract or block source ${source}`);
    }

    const pool = new pg.Pool({ connectionString: config.database, max: 8, options: `-c search_path=${quote(schema)}` });

    const transaction = async (body: (tx: pg.PoolClient) => Promise<void>) => {
      const tx = await pool.connect();
      try {
        await tx.query("BEGIN");
        await body(tx);
        await tx.query("COMMIT");
      } catch (err) {
        await tx.query("ROLLBACK");
        throw err;
      } finally {
        tx.release();
      }
    };
    const setMeta = (q: pg.PoolClient | pg.Pool, key: string, value: unknown) =>
      q.query(`INSERT INTO _kasbah_meta VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, JSON.stringify(value)]);
    /** Delivered when the transaction commits: API servers re-run live queries. */
    const notify = (tx: pg.PoolClient, checkpoint: number) => tx.query(`SELECT pg_notify($1, $2)`, [liveChannel(schema), JSON.stringify({ checkpoint })]);
    const saveHash = (q: pg.PoolClient | pg.Pool, block: BlockRef) =>
      q.query(`INSERT INTO _kasbah_blocks VALUES ($1, $2) ON CONFLICT (number) DO UPDATE SET hash = EXCLUDED.hash`, [block.number, block.hash]);

    let api: Api | undefined;
    let heads: HeadSubscription | undefined;
    try {
      const buildId = createHash("sha256")
        .update(JSON.stringify({
          contracts: Object.entries(config.contracts).map(([k, c]) => [
            k,
            c.address === undefined ? [canonical(c.factory.address), c.factory.event, c.factory.parameter] : canonical(c.address),
            c.startBlock,
          ]),
          blocks: blockSources.map((b) => [b.name, b.interval, b.startBlock, b.endBlock ?? null]),
          tables: tables.map((t) => createTableSql(tableInfo(t))),
          handlers: [...handlers.keys()].sort(),
        }))
        .digest("hex")
        .slice(0, 16);

      if (options.reset) await pool.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
      await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quote(schema)}`);
      let checkpoint: number | undefined;
      let stored: Record<string, unknown> = {};
      const known = new Map<number, string>();
      const storedChildren: { address: string; contract: string; block: number }[] = [];
      await transaction(async (tx) => {
        for (const sql of META_SQL) await tx.query(sql);
        const meta = await tx.query<{ key: string; value: unknown }>(`SELECT key, value FROM _kasbah_meta`);
        stored = Object.fromEntries(meta.rows.map((r) => [r.key, r.value]));
        if (stored.build !== undefined && stored.build !== buildId) {
          throw new Error(`schema "${schema}" holds another build of this app (config, tables or handlers changed); run with reset`);
        }
        checkpoint = stored.checkpoint as number | undefined;
        for (const t of tables) await tx.query(createTableSql(tableInfo(t)));
        await tx.query(`INSERT INTO _kasbah_meta VALUES ('build', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify(buildId)]);
        for (const b of (await tx.query<{ number: number; hash: string }>(`SELECT number, hash FROM _kasbah_blocks`)).rows) known.set(b.number, b.hash);
        storedChildren.push(...(await tx.query(`SELECT address, contract, block FROM _kasbah_children ORDER BY block`)).rows);
      });

      if (config.api !== undefined) {
        api = await Api.start({ ...config.api, database: config.database, schema, tables: config.tables });
        log(`API on http://${config.api.host ?? "127.0.0.1"}:${api.port} (POST /sql, POST /graphql, GET /status, GET /live)`);
      }

      const store = new Store(drizzle(pool), tables, { complete: checkpoint === undefined });
      const rpc = new RpcClient(config.rpc, { maxConcurrency: config.concurrency ?? 32 });
      const endpoint = await probe(rpc);
      const tip = await blockNumber(rpc);
      const live = options.to === undefined;
      const backfillTo = live ? tip - window : Math.min(options.to!, tip);
      // Classes are looked up to the tip when following it: live blocks decode with the class active now.
      const classTo = live ? tip : backfillTo;
      const cache = config.cache
        ? await EventCache.open(pool, await rpc.request<string>("starknet_chainId", []), config.cache === true ? {} : config.cache)
        : undefined;
      /** Blocks at or below this can't be reorged: backfill's end, then the head minus the reorg window. */
      let finalThrough = backfillTo;
      const client = new CallClient(rpc, { isFinal: (b) => b <= finalThrough, cache });
      const context = { db: store.db, client };

      const handledOf = (name: string) => new Set([...handlers.keys()].filter((h) => h.startsWith(`${name}:`)).map((h) => h.slice(name.length + 1)));
      const sources = new Sources(
        rpc,
        Object.entries(config.contracts).map(([name, c]) => ({ name, abi: c.abi, startBlock: c.startBlock, handled: handledOf(name) })),
        log,
      );
      const factories = await Promise.all(
        Object.entries(config.contracts).flatMap(([name, c]) => {
          if (c.factory === undefined) return [];
          return [(async () => {
            const f: FactorySource = { contract: name, address: canonical(c.factory.address), abi: c.factory.abi, event: c.factory.event, parameter: c.factory.parameter, startBlock: c.startBlock };
            const spans = await classHistory(rpc, f.address, f.startBlock, classTo);
            if (spans.length === 0) throw new Error(`${name}: factory ${f.address} is not deployed by block ${classTo}`);
            const reader = factoryReader(f, await Promise.all(spans.map(async (s) => ({ ...s, abi: await sources.abiOf(s.classHash) }))));
            return { ...f, reader, discovered: (stored[`discovered:${name}`] as number | undefined) ?? f.startBlock - 1 };
          })()];
        }),
      );
      const factoryByAddress = new Map(factories.map((f) => [f.address, f]));
      await Promise.all(
        Object.entries(config.contracts).flatMap(([name, c]) => (c.address === undefined ? [] : [sources.add(name, c.address, c.startBlock, classTo, false)])),
      );
      log(`${endpoint.node} endpoint, spec ${endpoint.spec}, tip ${tip}; ${sources.addresses.length + storedChildren.length} contracts${factories.length > 0 ? `, ${factories.length} factories` : ""}${blockSources.length > 0 ? `, ${blockSources.length} block sources` : ""}`);

      /** Ordered batches of `addresses` × `keys` in `[from, to]`: the cached prefix first, then RPC (tracked for the cache). */
      async function* fetchRange(addresses: string[], keys: string[][], from: number, to: number): AsyncGenerator<Batch> {
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
        for await (const batch of eventStream({ rpc, address: addresses, keys, from: start, to, chunkSize: endpoint.maxChunk, concurrency: config.concurrency ?? 32 })) {
          cache?.add(batch.events);
          yield batch;
        }
      }

      let indexed = 0;
      const handle = async (e: EmittedEvent) => {
        const w = sources.byAddress.get(e.from_address) ?? sources.byAddress.get(canonical(e.from_address));
        if (w === undefined || e.block_number! < w.from) return;
        const decoded = w.decode(e.block_number!, e.keys, e.data);
        if (decoded === undefined) return;
        const handler = handlers.get(`${w.contract}:${decoded.name}`);
        if (handler === undefined) return;
        const event = {
          contract: w.contract,
          name: decoded.name,
          args: decoded.args,
          address: padded(e.from_address),
          block: { number: e.block_number!, hash: e.block_hash },
          transaction: { hash: e.transaction_hash, index: e.transaction_index },
          index: e.event_index,
        };
        client.current = event.block;
        try {
          await handler({ event: event as never, context });
        } catch (err) {
          throw new Error(`${w.contract}:${decoded.name} at block ${e.block_number}, tx ${e.transaction_hash}: ${(err as Error).message}`, { cause: err });
        }
        indexed++;
      };

      const fireBlock = async (source: string, block: IndexedBlock["block"]) => {
        const handler = handlers.get(`${source}:block`);
        if (handler === undefined) return;
        client.current = block;
        try {
          await handler({ event: { source, block } as never, context });
        } catch (err) {
          throw new Error(`${source}:block at block ${block.number}: ${(err as Error).message}`, { cause: err });
        }
        indexed++;
      };
      const firesAt = (b: (typeof blockSources)[number], n: number) =>
        n >= b.startBlock && (b.endBlock === undefined || n <= b.endBlock) && (n - b.startBlock) % b.interval === 0;
      /** Block handlers due in `[from, to]`, in block order. */
      const firesIn = (from: number, to: number) => {
        const out: { source: string; number: number }[] = [];
        for (const b of blockSources) {
          const lo = Math.max(from, b.startBlock);
          const hi = Math.min(to, b.endBlock ?? to);
          for (let n = b.startBlock + Math.ceil((lo - b.startBlock) / b.interval) * b.interval; n <= hi; n += b.interval) out.push({ source: b.name, number: n });
        }
        return out.sort((x, y) => x.number - y.number);
      };
      const headersFor = async (numbers: number[]) => {
        const unique = [...new Set(numbers)];
        const found = (await cache?.headers(unique)) ?? new Map<number, { hash: string; parent: string; timestamp: number }>();
        const missing = unique.filter((n) => !found.has(n));
        const fetched = await getHeaders(rpc, missing, 100);
        await cache?.saveHeaders(fetched.filter((h) => h.block_number <= backfillTo));
        for (const h of fetched) found.set(h.block_number, { hash: h.block_hash, parent: h.parent_hash, timestamp: h.timestamp });
        return found;
      };

      const revert = async (ancestor: BlockRef) => {
        let undone = 0;
        await transaction(async (tx) => {
          undone = await store.revert(tx, ancestor.number);
          await tx.query(`DELETE FROM _kasbah_blocks WHERE number > $1`, [ancestor.number]);
          await tx.query(`DELETE FROM _kasbah_children WHERE block > $1`, [ancestor.number]);
          for (const f of factories) if (f.discovered > ancestor.number) await setMeta(tx, `discovered:${f.contract}`, ancestor.number);
          await setMeta(tx, "checkpoint", ancestor.number);
          await notify(tx, ancestor.number);
        });
        for (const f of factories) f.discovered = Math.min(f.discovered, ancestor.number);
        const forgotten = sources.removeChildrenAfter(ancestor.number);
        for (const n of known.keys()) if (n > ancestor.number) known.delete(n);
        checkpoint = ancestor.number;
        log(`reverted to block ${ancestor.number}, ${undone} row changes undone${forgotten.length > 0 ? `, ${forgotten.length} children forgotten` : ""}`);
      };

      // Stopped while live: the blocks indexed last may have been reorged since. Backfill trusts its start, so check.
      if (checkpoint !== undefined && known.has(checkpoint)) {
        const ancestor = await findAncestor(rpc, checkpoint, known);
        if (ancestor.number < checkpoint) {
          log(`reorg while stopped: block ${checkpoint} replaced, back to ${ancestor.number}`);
          await revert(ancestor);
        }
      }

      // Children found by earlier runs, minus those whose creation a reorg while stopped just undid.
      await Promise.all(
        storedChildren.filter((ch) => ch.block <= Math.min(...factories.map((f) => f.discovered)))
          .map((ch) => sources.add(ch.contract, ch.address, ch.block, classTo, true)),
      );

      // Factory pre-pass: every child created up to the backfill end, before any child event is fetched.
      const discoverFrom = Math.min(...factories.map((f) => f.discovered + 1));
      if (factories.length > 0 && discoverFrom <= backfillTo) {
        const started = performance.now();
        const found: { address: string; contract: string; block: number }[] = [];
        const selectors = [...new Set(factories.flatMap((f) => f.reader.selectors))];
        let through = discoverFrom - 1;
        for await (const batch of fetchRange(factories.map((f) => f.address), [selectors], discoverFrom, backfillTo)) {
          for (const e of batch.events) {
            const f = factoryByAddress.get(canonical(e.from_address));
            if (f === undefined || e.block_number! <= f.discovered || e.block_number! < f.startBlock) continue;
            const child = f.reader.child(e);
            if (child !== undefined) found.push({ address: child, contract: f.contract, block: e.block_number! });
          }
          through = batch.through;
          if (signal.aborted) break;
        }
        const added = (await Promise.all(found.map((c) => sources.add(c.contract, c.address, c.block, classTo, true)))).filter((w) => w !== undefined);
        await transaction(async (tx) => {
          for (const w of added) await tx.query(`INSERT INTO _kasbah_children VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [w.address, w.contract, w.from]);
          for (const f of factories) {
            f.discovered = Math.max(f.discovered, through);
            await setMeta(tx, `discovered:${f.contract}`, f.discovered);
          }
          await cache?.persist(tx, through);
        });
        cache?.untrack();
        log(`factories: ${added.length} children up to block ${through} in ${((performance.now() - started) / 1000).toFixed(1)}s`);
        if (signal.aborted) return;
      }

      // Backfill: final blocks, no journal, one transaction every FLUSH_EVENTS events or block handlers.
      const starts = [...Object.values(config.contracts).map((c) => c.startBlock), ...blockSources.map((b) => b.startBlock)];
      const first = Math.max(Math.min(...starts), (checkpoint ?? -1) + 1);
      if (first <= backfillTo) {
        await setMeta(pool, "phase", "backfill");
        const started = performance.now();
        let sinceFlush = 0;
        let through = first - 1;
        const commit = () =>
          transaction(async (tx) => {
            await store.flush(tx);
            await cache?.persist(tx, through);
            await setMeta(tx, "checkpoint", through);
            await notify(tx, through);
          });
        for await (const batch of fetchRange(sources.addresses, sources.keys, first, backfillTo)) {
          const fires = firesIn(through + 1, batch.through);
          const headers = fires.length > 0 ? await headersFor(fires.map((f) => f.number)) : undefined;
          let i = 0;
          const fireUntil = async (block: number) => {
            for (; i < fires.length && fires[i]!.number < block; i++) {
              const h = headers!.get(fires[i]!.number)!;
              await fireBlock(fires[i]!.source, { number: fires[i]!.number, hash: h.hash, timestamp: h.timestamp });
            }
          };
          for (const e of batch.events) {
            await fireUntil(e.block_number!);
            await handle(e);
          }
          await fireUntil(batch.through + 1);
          sinceFlush += batch.events.length + fires.length;
          through = batch.through;
          if (signal.aborted) break;
          if (sinceFlush >= FLUSH_EVENTS || through === backfillTo) {
            await commit();
            sinceFlush = 0;
            const seconds = (performance.now() - started) / 1000;
            log(`block ${through}/${backfillTo} (${(((through - first + 1) / (backfillTo - first + 1)) * 100).toFixed(1)}%), ${indexed} handled, ${Math.round(indexed / seconds)}/s`);
          }
        }
        if (!signal.aborted) through = backfillTo;
        await commit();
        cache?.untrack();
        checkpoint = through;
        if (signal.aborted) return;
        const c = cache?.stats;
        const calls = client.stats.calls + client.stats.cached;
        log(`backfill done: ${indexed} handled in ${((performance.now() - started) / 1000).toFixed(1)}s${c === undefined ? "" : ` (${c.cachedEvents} events from the cache, ${c.fetchedEvents} fetched)`}${calls === 0 ? "" : `, ${calls} contract reads (${client.stats.cached} cached)`}`);
      }
      if (!live) return;

      // Live: one transaction per block with its undo journal and hash, kept for the reorg window.
      const last = checkpoint ?? first - 1;
      let head: BlockRef;
      const knownHash = known.get(last);
      if (knownHash !== undefined) head = { number: last, hash: knownHash };
      else {
        const [header] = await getHeaders(rpc, [last], 1);
        head = { number: last, hash: header!.block_hash };
        await saveHash(pool, head);
        known.set(last, head.hash);
      }
      store.journal = true;
      await setMeta(pool, "phase", "live");
      log(`following the head from block ${head.number}`);

      const factorySelectors = [[...new Set(factories.flatMap((f) => f.reader.selectors))]];
      /** Children created in blocks fetched but not yet committed. */
      let newChildren = new Map<number, { address: string; contract: string }[]>();
      const prepare = async (from: number, to: number) => {
        sources.removeChildrenAfter(from - 1);
        newChildren = new Map();
        if (factories.length > 0) {
          const filter = { from_block: { block_number: from }, to_block: { block_number: to }, address: factories.map((f) => f.address), keys: factorySelectors };
          let token: string | undefined;
          do {
            const page = await getEvents(rpc, filter, endpoint.maxChunk, token);
            for (const e of page.events) {
              const f = factoryByAddress.get(canonical(e.from_address));
              const child = f === undefined ? undefined : f.reader.child(e);
              if (f === undefined || child === undefined) continue;
              const w = await sources.add(f.contract, child, e.block_number!, to, true);
              if (w !== undefined) newChildren.set(w.from, [...(newChildren.get(w.from) ?? []), { address: w.address, contract: w.contract }]);
            }
            token = page.continuation_token;
          } while (token !== undefined);
        }
        await sources.checkClasses(from, to);
      };

      const pollMs = config.pollMs ?? 2_000;
      if (config.ws !== undefined) {
        heads = new HeadSubscription(config.ws === true ? config.rpc.replace(/^http/, "ws") : config.ws, log);
        log("WebSocket: following new heads");
      }
      const h = heads;
      await follow({
        rpc, address: sources.addresses, keys: sources.keys, chunkSize: endpoint.maxChunk, head, known, signal, log,
        pollMs,
        // With a socket up, a missed head costs at most 15 s; without, poll as usual.
        wait: h === undefined ? undefined : (signal) => h.wait(h.healthy ? Math.max(pollMs, 15_000) : pollMs, signal),
        prepare,
        onBlock: async (block) => {
          finalThrough = Math.max(finalThrough, block.number - window);
          for (const e of block.events) await handle(e);
          for (const b of blockSources) if (firesAt(b, block.number)) await fireBlock(b.name, { number: block.number, hash: block.hash, timestamp: block.timestamp });
          const prune = block.number - window;
          const children = newChildren.get(block.number) ?? [];
          await transaction(async (tx) => {
            await store.flush(tx, block.number);
            await cache?.persist(tx, -1);
            for (const c of children) await tx.query(`INSERT INTO _kasbah_children VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [c.address, c.contract, block.number]);
            for (const f of factories) await setMeta(tx, `discovered:${f.contract}`, block.number);
            await saveHash(tx, block);
            await tx.query(`DELETE FROM _kasbah_blocks WHERE number < $1`, [prune]);
            await tx.query(`DELETE FROM _kasbah_journal WHERE block < $1`, [prune]);
            await setMeta(tx, "checkpoint", block.number);
            await notify(tx, block.number);
          });
          for (const f of factories) f.discovered = block.number;
          known.set(block.number, block.hash);
          for (const n of known.keys()) if (n < prune) known.delete(n);
          if (block.events.length > 0 || children.length > 0) {
            const behind = Date.now() / 1000 - block.timestamp;
            log(`block ${block.number}: ${block.events.length} events${children.length > 0 ? `, ${children.length} new children` : ""}, ${behind.toFixed(1)}s after its timestamp`);
          }
        },
        onReorg: revert,
      });
    } finally {
      heads?.close();
      await api?.close();
      await pool.end();
    }
  };

  return { on, run };
}
