import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgTable } from "drizzle-orm/pg-core";
import pg from "pg";
import type { Abi } from "./abi/abi.ts";
import { abiEvents } from "./abi/events.ts";
import { type ClassSpan, classHistory, createHistoricalDecoder } from "./abi/history.ts";
import type { EventArgs, EventName } from "./abi/types.ts";
import { Store, type Db } from "./db/store.ts";
import { createTableSql, quote, tableInfo } from "./db/table.ts";
import { Api } from "./api/server.ts";
import { RpcClient } from "./rpc/client.ts";
import { blockNumber, type EmittedEvent, getHeaders } from "./rpc/methods.ts";
import { probe } from "./rpc/probe.ts";
import { eventStream } from "./sync/fetch.ts";
import { type BlockRef, findAncestor, follow } from "./sync/live.ts";

export type ContractConfig = { abi: Abi; address: string; startBlock: number };

export type Config = {
  rpc: string;
  database: string;
  /** Postgres schema holding the app's tables. */
  schema?: string;
  contracts: Record<string, ContractConfig>;
  tables: Record<string, PgTable>;
  /** Parallel `getEvents` windows. */
  concurrency?: number;
  /** Blocks behind the tip that can still be reorged: indexed live, with an undo journal. Default 64. */
  reorgWindow?: number;
  /** Head polling interval. Default 2 s. */
  pollMs?: number;
  /** Serve the read API (SQL over HTTP, GraphQL) while indexing. */
  api?: { port: number; host?: string; readDatabase?: string };
};

export const createConfig = <const C extends Config>(config: C): C => config;

type Contracts<C extends Config> = C["contracts"];

export type HandlerName<C extends Config> = {
  [K in keyof Contracts<C> & string]: `${K}:${EventName<Contracts<C>[K]["abi"]>}`;
}[keyof Contracts<C> & string];

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
    : never
  : never;

export type Handler<C extends Config, N extends HandlerName<C>> = (arg: {
  event: IndexedEvent<C, N>;
  context: { db: Db };
}) => void | Promise<void>;

export type RunOptions = {
  /** Index up to this block and stop. Without it, backfill then follow the head until `signal` aborts. */
  to?: number;
  /** Drop the app's schema first. */
  reset?: boolean;
  signal?: AbortSignal;
  log?: (line: string) => void;
};

const canonical = (address: string) => `0x${BigInt(address).toString(16)}`;
const padded = (address: string) => `0x${BigInt(address).toString(16).padStart(64, "0")}` as `0x${string}`;

/** Events handled between two database transactions during backfill (each one is a checkpoint). */
const FLUSH_EVENTS = 100_000;

const META_SQL = [
  `CREATE TABLE IF NOT EXISTS _kasbah_meta (key text PRIMARY KEY, value jsonb NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS _kasbah_blocks (number integer PRIMARY KEY, hash text NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS _kasbah_journal (block integer NOT NULL, seq bigserial, tbl text NOT NULL, pk jsonb NOT NULL, before jsonb)`,
  `CREATE INDEX IF NOT EXISTS _kasbah_journal_block ON _kasbah_journal (block)`,
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
    const tables = Object.values(config.tables);
    const pool = new pg.Pool({ connectionString: config.database, max: 8 });
    pool.on("connect", (c) => void c.query(`SET search_path TO ${quote(schema)}`));

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
    const setCheckpoint = (tx: pg.PoolClient, block: number) =>
      tx.query(`INSERT INTO _kasbah_meta VALUES ('checkpoint', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(block)]);
    const setPhase = (phase: "backfill" | "live") =>
      pool.query(`INSERT INTO _kasbah_meta VALUES ('phase', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(phase)]);
    const saveHash = (q: pg.PoolClient | pg.Pool, block: BlockRef) =>
      q.query(`INSERT INTO _kasbah_blocks VALUES ($1, $2) ON CONFLICT (number) DO UPDATE SET hash = EXCLUDED.hash`, [block.number, block.hash]);

    let api: Api | undefined;
    try {
      const buildId = createHash("sha256")
        .update(JSON.stringify({
          contracts: Object.entries(config.contracts).map(([k, c]) => [k, canonical(c.address), c.startBlock]),
          tables: tables.map((t) => createTableSql(tableInfo(t))),
          handlers: [...handlers.keys()].sort(),
        }))
        .digest("hex")
        .slice(0, 16);

      if (options.reset) await pool.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
      await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quote(schema)}`);
      let checkpoint: number | undefined;
      const known = new Map<number, string>();
      await transaction(async (tx) => {
        for (const sql of META_SQL) await tx.query(sql);
        const meta = await tx.query<{ key: string; value: unknown }>(`SELECT key, value FROM _kasbah_meta`);
        const stored = Object.fromEntries(meta.rows.map((r) => [r.key, r.value]));
        if (stored.build !== undefined && stored.build !== buildId) {
          throw new Error(`schema "${schema}" holds another build of this app (contracts, tables or handlers changed); run with reset`);
        }
        checkpoint = stored.checkpoint as number | undefined;
        for (const t of tables) await tx.query(createTableSql(tableInfo(t)));
        await tx.query(`INSERT INTO _kasbah_meta VALUES ('build', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify(buildId)]);
        const blocks = await tx.query<{ number: number; hash: string }>(`SELECT number, hash FROM _kasbah_blocks`);
        for (const b of blocks.rows) known.set(b.number, b.hash);
      });

      if (config.api !== undefined) {
        api = await Api.start({ ...config.api, database: config.database, schema, tables: config.tables });
        log(`API on http://${config.api.host ?? "127.0.0.1"}:${api.port} (POST /sql, POST /graphql, GET /status)`);
      }

      const store = new Store(drizzle(pool), tables, { complete: checkpoint === undefined });
      const rpc = new RpcClient(config.rpc, { maxConcurrency: config.concurrency ?? 32 });
      const endpoint = await probe(rpc);
      const tip = await blockNumber(rpc);
      const live = options.to === undefined;
      const backfillTo = live ? tip - window : Math.min(options.to!, tip);

      // Classes are looked up to the tip when following it: live blocks decode with the class active now.
      const abis = new Map<string, Promise<Abi>>();
      const abiOf = (classHash: string) => {
        let abi = abis.get(classHash);
        if (abi === undefined) {
          abi = rpc.request<{ abi: string | Abi }>("starknet_getClass", { block_id: "latest", class_hash: classHash })
            .then((cls) => (typeof cls.abi === "string" ? JSON.parse(cls.abi) : cls.abi) as Abi);
          abis.set(classHash, abi);
        }
        return abi;
      };
      const keys: string[][] = [[]];

      const contracts = await Promise.all(
        Object.entries(config.contracts).map(async ([name, c]) => {
          const spans = await classHistory(rpc, c.address, c.startBlock, live ? tip : backfillTo);
          if (spans.length === 0) throw new Error(`${name} is not deployed at ${c.address} by block ${tip}`);
          const handled = new Set([...handlers.keys()].filter((h) => h.startsWith(`${name}:`)).map((h) => h.slice(name.length + 1)));
          const configured = new Set(abiEvents(c.abi).map((e) => e.name));
          const contract = {
            name,
            address: canonical(c.address),
            startBlock: c.startBlock,
            spans: [] as (ClassSpan & { abi: Abi })[],
            decode: createHistoricalDecoder([]),
            /** Classes are known up to this block. */
            checked: live ? tip : backfillTo,
            /** Adds class spans: new handled selectors join the filter, unknown event names are reported. */
            async add(added: ClassSpan[]) {
              const withAbis = await Promise.all(added.map(async (s) => ({ ...s, abi: await abiOf(s.classHash) })));
              const missing = new Set<string>();
              for (const s of withAbis) {
                for (const e of abiEvents(s.abi)) {
                  if (handled.has(e.name) && !keys[0]!.includes(e.selectors[0]!)) keys[0]!.push(e.selectors[0]!);
                  if (!configured.has(e.name)) missing.add(e.name);
                }
              }
              if (missing.size > 0) log(`${name}: some classes emit events not in the configured ABI, they are skipped: ${[...missing].join(", ")}`);
              this.spans.push(...withAbis);
              this.decode = createHistoricalDecoder(this.spans);
            },
          };
          await contract.add(spans);
          return contract;
        }),
      );
      const byAddress = new Map(contracts.map((c) => [c.address, c]));
      const addresses = contracts.map((c) => c.address);
      log(`${endpoint.node} endpoint, spec ${endpoint.spec}, tip ${tip}; ${contracts.map((c) => `${c.name}: ${c.spans.length} classes`).join(", ")}`);

      /** Before live blocks up to `to` are indexed: one batched class check, a bisection only if one changed. */
      const checkClasses = async (to: number) => {
        const current = await rpc.batch<string[]>(
          contracts.map((c) => ({ method: "starknet_getClassHashAt", params: { block_id: { block_number: to }, contract_address: c.address } })),
        );
        await Promise.all(contracts.map(async (c, i) => {
          if (to <= c.checked) return;
          if (current[i] !== c.spans.at(-1)!.classHash) {
            const changes = (await classHistory(rpc, c.address, c.checked, to)).slice(1);
            log(`${c.name}: class replaced at block ${changes.map((s) => `${s.from} (${s.classHash})`).join(", ")}`);
            await c.add(changes);
          }
          c.checked = to;
        }));
      };
      if (keys[0]!.length === 0) {
        log("no handlers registered");
        return;
      }

      let indexed = 0;
      const handle = async (e: EmittedEvent) => {
        const contract = byAddress.get(e.from_address);
        if (contract === undefined || e.block_number! < contract.startBlock) return;
        const decoded = contract.decode(e.block_number!, e.keys, e.data);
        if (decoded === undefined) return;
        const handler = handlers.get(`${contract.name}:${decoded.name}`);
        if (handler === undefined) return;
        const event = {
          contract: contract.name,
          name: decoded.name,
          args: decoded.args,
          address: padded(e.from_address),
          block: { number: e.block_number!, hash: e.block_hash },
          transaction: { hash: e.transaction_hash, index: e.transaction_index },
          index: e.event_index,
        };
        try {
          await handler({ event: event as never, context: { db: store.db } });
        } catch (err) {
          throw new Error(`${contract.name}:${decoded.name} at block ${e.block_number}, tx ${e.transaction_hash}: ${(err as Error).message}`, { cause: err });
        }
        indexed++;
      };

      const revert = async (ancestor: BlockRef) => {
        let undone = 0;
        await transaction(async (tx) => {
          undone = await store.revert(tx, ancestor.number);
          await tx.query(`DELETE FROM _kasbah_blocks WHERE number > $1`, [ancestor.number]);
          await setCheckpoint(tx, ancestor.number);
        });
        for (const n of known.keys()) if (n > ancestor.number) known.delete(n);
        checkpoint = ancestor.number;
        log(`reverted to block ${ancestor.number}, ${undone} row changes undone`);
      };

      // Stopped while live: the blocks indexed last may have been reorged since. Backfill trusts its start, so check.
      if (checkpoint !== undefined && known.has(checkpoint)) {
        const ancestor = await findAncestor(rpc, checkpoint, known);
        if (ancestor.number < checkpoint) {
          log(`reorg while stopped: block ${checkpoint} replaced, back to ${ancestor.number}`);
          await revert(ancestor);
        }
      }

      // Backfill: final blocks, no journal, one transaction every FLUSH_EVENTS events.
      const first = Math.max(Math.min(...contracts.map((c) => c.startBlock)), (checkpoint ?? -1) + 1);
      if (first <= backfillTo) {
        await setPhase("backfill");
        const started = performance.now();
        let sinceFlush = 0;
        let through = first - 1;
        const commit = () =>
          transaction(async (tx) => {
            await store.flush(tx);
            await setCheckpoint(tx, through);
          });
        const stream = eventStream({ rpc, address: addresses, keys, from: first, to: backfillTo, chunkSize: endpoint.maxChunk, concurrency: config.concurrency ?? 32 });
        for await (const batch of stream) {
          for (const e of batch.events) await handle(e);
          sinceFlush += batch.events.length;
          through = batch.through;
          if (signal.aborted) break;
          if (sinceFlush >= FLUSH_EVENTS || through === backfillTo) {
            await commit();
            sinceFlush = 0;
            const seconds = (performance.now() - started) / 1000;
            log(`block ${through}/${backfillTo} (${(((through - first + 1) / (backfillTo - first + 1)) * 100).toFixed(1)}%), ${indexed} events, ${Math.round(indexed / seconds)}/s`);
          }
        }
        if (!signal.aborted) through = backfillTo;
        await commit();
        checkpoint = through;
        if (signal.aborted) return;
        log(`backfill done: ${indexed} events in ${((performance.now() - started) / 1000).toFixed(1)}s`);
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
      await setPhase("live");
      log(`following the head from block ${head.number}`);
      await follow({
        rpc, address: addresses, keys, chunkSize: endpoint.maxChunk, head, known, signal, log,
        pollMs: config.pollMs ?? 2_000,
        prepare: checkClasses,
        onBlock: async (block) => {
          for (const e of block.events) await handle(e);
          const prune = block.number - window;
          await transaction(async (tx) => {
            await store.flush(tx, block.number);
            await saveHash(tx, block);
            await tx.query(`DELETE FROM _kasbah_blocks WHERE number < $1`, [prune]);
            await tx.query(`DELETE FROM _kasbah_journal WHERE block < $1`, [prune]);
            await setCheckpoint(tx, block.number);
          });
          known.set(block.number, block.hash);
          for (const n of known.keys()) if (n < prune) known.delete(n);
          if (block.events.length > 0) log(`block ${block.number}: ${block.events.length} events`);
        },
        onReorg: revert,
      });
    } finally {
      await api?.close();
      await pool.end();
    }
  };

  return { on, run };
}
