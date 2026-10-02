import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgTable } from "drizzle-orm/pg-core";
import pg from "pg";
import type { Abi } from "./abi/abi.ts";
import { abiEvents } from "./abi/events.ts";
import { classHistory, createHistoricalDecoder } from "./abi/history.ts";
import type { EventArgs, EventName } from "./abi/types.ts";
import { Store, type Db } from "./db/store.ts";
import { createTableSql, quote, tableInfo } from "./db/table.ts";
import { RpcClient } from "./rpc/client.ts";
import { blockNumber } from "./rpc/methods.ts";
import { probe } from "./rpc/probe.ts";
import { eventStream } from "./sync/fetch.ts";

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
  /** Last block to index; defaults to the head at start. */
  to?: number;
  /** Drop the app's schema first. */
  reset?: boolean;
  log?: (line: string) => void;
};

const canonical = (address: string) => `0x${BigInt(address).toString(16)}`;
const padded = (address: string) => `0x${BigInt(address).toString(16).padStart(64, "0")}` as `0x${string}`;

/** Events handled between two database transactions (each one is a checkpoint). */
const FLUSH_EVENTS = 100_000;

export function kasbah<const C extends Config>(config: C) {
  const handlers = new Map<string, Handler<C, HandlerName<C>>>();

  const on = <N extends HandlerName<C>>(name: N, handler: Handler<C, N>) => {
    if (handlers.has(name)) throw new Error(`${name} already has a handler`);
    handlers.set(name, handler as never);
  };

  const run = async (options: RunOptions = {}) => {
    const log = options.log ?? ((line: string) => console.log(`[kasbah] ${line}`));
    const schema = config.schema ?? "kasbah";
    const tables = Object.values(config.tables);
    const pool = new pg.Pool({ connectionString: config.database, max: 8 });
    pool.on("connect", (c) => void c.query(`SET search_path TO ${quote(schema)}`));
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
      const client = await pool.connect();
      let checkpoint: number | undefined;
      try {
        await client.query(`CREATE TABLE IF NOT EXISTS _kasbah_meta (key text PRIMARY KEY, value jsonb NOT NULL)`);
        const meta = await client.query<{ key: string; value: unknown }>(`SELECT key, value FROM _kasbah_meta`);
        const stored = Object.fromEntries(meta.rows.map((r) => [r.key, r.value]));
        if (stored.build !== undefined && stored.build !== buildId) {
          throw new Error(`schema "${schema}" holds another build of this app (contracts, tables or handlers changed); run with reset`);
        }
        checkpoint = stored.checkpoint as number | undefined;
        for (const t of tables) await client.query(createTableSql(tableInfo(t)));
        await client.query(`INSERT INTO _kasbah_meta VALUES ('build', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify(buildId)]);
      } finally {
        client.release();
      }

      const store = new Store(drizzle(pool), tables, { complete: checkpoint === undefined });
      const rpc = new RpcClient(config.rpc, { maxConcurrency: config.concurrency ?? 32 });
      const endpoint = await probe(rpc);
      const head = await blockNumber(rpc);
      const to = Math.min(options.to ?? head, head);

      const contracts = await Promise.all(
        Object.entries(config.contracts).map(async ([name, c]) => {
          const spans = await classHistory(rpc, c.address, c.startBlock, to);
          if (spans.length === 0) throw new Error(`${name} is not deployed at ${c.address} by block ${to}`);
          const withAbis = await Promise.all(spans.map(async (s) => {
            const cls = await rpc.request<{ abi: string | Abi }>("starknet_getClass", { block_id: "latest", class_hash: s.classHash });
            return { ...s, abi: (typeof cls.abi === "string" ? JSON.parse(cls.abi) : cls.abi) as Abi };
          }));
          const handled = new Set([...handlers.keys()].filter((h) => h.startsWith(`${name}:`)).map((h) => h.slice(name.length + 1)));
          const selectors = new Set<string>();
          const configured = new Set(abiEvents(c.abi).map((e) => e.name));
          const missing = new Set<string>();
          for (const s of withAbis) {
            for (const e of abiEvents(s.abi)) {
              if (handled.has(e.name)) selectors.add(e.selectors[0]!);
              if (!configured.has(e.name)) missing.add(e.name);
            }
          }
          if (missing.size > 0) {
            log(`${name}: older classes emit events not in the configured ABI, they are skipped: ${[...missing].join(", ")}`);
          }
          return { name, address: canonical(c.address), startBlock: c.startBlock, classes: spans.length, decode: createHistoricalDecoder(withAbis), selectors };
        }),
      );
      const byAddress = new Map(contracts.map((c) => [c.address, c]));
      const keys = [[...new Set(contracts.flatMap((c) => [...c.selectors]))]];
      const addresses = contracts.map((c) => c.address);
      log(`${endpoint.node} endpoint, spec ${endpoint.spec}; ${contracts.map((c) => `${c.name}: ${c.classes} classes`).join(", ")}`);

      const first = Math.max(Math.min(...contracts.map((c) => c.startBlock)), checkpoint === undefined ? 0 : checkpoint + 1);
      if (keys[0]!.length === 0 || first > to) {
        log(first > to ? `already at block ${checkpoint}` : "no handlers registered");
        return;
      }

      const flush = async (through: number) => {
        const tx = await pool.connect();
        try {
          await tx.query("BEGIN");
          await store.flush(tx);
          await tx.query(`INSERT INTO _kasbah_meta VALUES ('checkpoint', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(through)]);
          await tx.query("COMMIT");
        } catch (err) {
          await tx.query("ROLLBACK");
          throw err;
        } finally {
          tx.release();
        }
      };

      const started = performance.now();
      let indexed = 0;
      let sinceFlush = 0;
      let through = first - 1;
      const stream = eventStream({
        rpc, address: addresses, keys, from: first, to, chunkSize: endpoint.maxChunk,
        concurrency: config.concurrency ?? 32,
      });
      for await (const batch of stream) {
        for (const e of batch.events) {
          const contract = byAddress.get(e.from_address);
          if (contract === undefined || e.block_number! < contract.startBlock) continue;
          const decoded = contract.decode(e.block_number!, e.keys, e.data);
          if (decoded === undefined) continue;
          const handler = handlers.get(`${contract.name}:${decoded.name}`);
          if (handler === undefined) continue;
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
        }
        sinceFlush += batch.events.length;
        through = batch.through;
        if (sinceFlush >= FLUSH_EVENTS || through === to) {
          await flush(through);
          sinceFlush = 0;
          const seconds = (performance.now() - started) / 1000;
          log(`block ${through}/${to} (${(((through - first + 1) / (to - first + 1)) * 100).toFixed(1)}%), ${indexed} events, ${Math.round(indexed / seconds)}/s`);
        }
      }
      if (through < to) await flush(to);
      log(`done: ${indexed} events in ${((performance.now() - started) / 1000).toFixed(1)}s`);
    } finally {
      await pool.end();
    }
  };

  return { on, run };
}
