import { and, eq, type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgTable } from "drizzle-orm/pg-core";
import type { PoolClient } from "pg";
import { ConfigError } from "../config/errors.ts";
import { chunks } from "../utils/chunks.ts";
import { errorCode } from "../utils/errors.ts";
import { approxBytes, heapLimit } from "../utils/memory.ts";
import { copyRows } from "./copy.ts";
import { jsonSafe, primaryKeySql, quote, type Row, type TableInfo, tableInfo } from "./table.ts";

/** Rows per DELETE: one parameter per key column each, far under Postgres's 65,535 per statement. */
const ROWS_PER_DELETE = 1_000;
/** Share of the heap for cached rows, all tables together, as Ponder's indexing cache. */
const HEAP_SHARE = 1 / 5;
/** Share of `maxCachedBytes` left after an eviction, so the next flush doesn't evict again at once. */
const CACHE_KEPT = 0.8;

type Pending = { op: "insert" | "upsert"; row: Row } | { op: "delete"; row: Row };

type State = {
  info: TableInfo;
  cache: Map<string, Row | null>;
  /** Estimated, of `cache`'s keys and rows. */
  bytes: number;
  /** Reads `cache` answered: tables read least are evicted first. */
  hits: number;
  complete: boolean;
  pending: Map<string, Pending>;
  /** Estimated, of `pending`'s rows. */
  pendingBytes: number;
  before: Map<string, Row | null>;
  keyed: boolean;
};

export type StoreOptions = {
  complete: boolean;
  /** Estimated bytes of cached rows, all tables together. Default: `heap / 5`. */
  maxCachedBytes?: number;
  /**
   * Tables created without their primary key (backfill: a random key, like a transaction hash, made inserts four
   * times slower). Each gets it when first needed: an upsert, a delete or a read from Postgres, or `addKeys`.
   */
  unkeyed?: ReadonlySet<string>;
};

type Key<T extends PgTable> = Partial<InferSelectModel<T>>;
type Values<T extends PgTable> = InferInsertModel<T>;
type Selected<T extends PgTable> = InferSelectModel<T>;

/** The handler-facing database: reads and writes go to memory, `flush` writes them out in one transaction. */
export type Db = {
  find<T extends PgTable>(table: T, key: Key<T>): Promise<Selected<T> | null>;
  insert<T extends PgTable>(
    table: T,
  ): {
    values(row: Values<T>): InsertQuery<T>;
  };
  update<T extends PgTable>(
    table: T,
    key: Key<T>,
  ): {
    set(
      change: Partial<Values<T>> | ((row: Selected<T>) => Partial<Values<T>>),
    ): Promise<Selected<T>>;
  };
  delete<T extends PgTable>(table: T, key: Key<T>): Promise<boolean>;
};

export type InsertQuery<T extends PgTable> = PromiseLike<Selected<T>> & {
  onConflictDoNothing(): Promise<Selected<T> | null>;
  onConflictDoUpdate(
    change: Partial<Values<T>> | ((row: Selected<T>) => Partial<Values<T>>),
  ): Promise<Selected<T>>;
};

function driverValues(row: Row, columns: TableInfo["columns"]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { key, column } of columns) {
    const v = row[key];
    out[column.name] = v === null || v === undefined ? null : column.mapToDriverValue(v);
  }
  return out;
}

export class Store {
  readonly db: Db;
  readonly #tables = new Map<PgTable, State>();
  readonly #orm: NodePgDatabase;
  readonly #maxCachedBytes: number;
  /** Record pre-images for the undo journal (blocks inside the reorg window). */
  journal = false;

  constructor(orm: NodePgDatabase, tables: PgTable[], options: StoreOptions) {
    this.#orm = orm;
    this.#maxCachedBytes = options.maxCachedBytes ?? Math.floor(heapLimit() * HEAP_SHARE);
    for (const t of tables) {
      const info = tableInfo(t);
      this.#tables.set(t, {
        info,
        cache: new Map(),
        bytes: 0,
        hits: 0,
        complete: options.complete,
        pending: new Map(),
        pendingBytes: 0,
        before: new Map(),
        keyed: !options.unkeyed?.has(info.name),
      });
    }
    this.db = this.#createDb();
  }

  #state(table: PgTable): State {
    const s = this.#tables.get(table);
    if (s === undefined) throw new Error("table is not in the kasbah config");
    return s;
  }

  async #get(s: State, key: Row): Promise<Row | null> {
    const k = s.info.keyOf(key);
    const cached = s.cache.get(k);
    if (cached !== undefined) {
      s.hits++;
      return cached;
    }
    if (s.complete) return null;
    await this.#addKey(s, (text) => this.#orm.execute(sql.raw(text)));
    const where = and(...s.info.primaryKey.map((c) => eq(c.column, key[c.key])));
    const [row] = await this.#orm.select().from(s.info.table).where(where).limit(1);
    this.#cache(s, k, (row as Row | undefined) ?? null);
    return (row as Row | undefined) ?? null;
  }

  /** Sets `k` as the newest entry, for eviction oldest first. */
  #cache(s: State, k: string, row: Row | null, bytes = approxBytes(row)) {
    const old = s.cache.get(k);
    if (old !== undefined) {
      s.cache.delete(k);
      s.bytes -= approxBytes(k) + approxBytes(old);
    }
    s.cache.set(k, row);
    s.bytes += approxBytes(k) + bytes;
  }

  #pend(s: State, k: string, p: Pending, bytes: number) {
    const old = s.pending.get(k);
    if (old !== undefined) s.pendingBytes -= approxBytes(old.row);
    s.pending.set(k, p);
    s.pendingBytes += bytes;
  }

  #remember(s: State, k: string, before: Row | null) {
    if (this.journal && !s.before.has(k)) s.before.set(k, before === null ? null : { ...before });
  }

  #write(s: State, row: Row, before: Row | null) {
    // In memory as Postgres will give it back, so a row reads the same before and after a flush.
    for (const key of s.info.json) row[key] = jsonSafe(row[key]);
    const existed = before !== null;
    const k = s.info.keyOf(row);
    this.#remember(s, k, before);
    const prior = s.pending.get(k)?.op;
    const op = prior === "insert" ? "insert" : prior !== undefined || existed ? "upsert" : "insert";
    const bytes = approxBytes(row);
    this.#pend(s, k, { op, row }, bytes);
    this.#cache(s, k, row, bytes);
  }

  #createDb(): Db {
    const insert = (table: PgTable, values: Row) => {
      const s = this.#state(table);
      const k = s.info.keyOf(values);
      const row = { ...values };
      const plain = async () => {
        const known = s.cache.get(k);
        if (known === undefined && !s.complete && !this.journal) {
          this.#write(s, row, null);
          return row;
        }
        if (await this.#get(s, row))
          throw new Error(`${s.info.name}: a row with key ${k} already exists`);
        this.#write(s, row, null);
        return row;
      };
      const query = {
        // biome-ignore lint/suspicious/noThenProperty: awaitable like Drizzle's builders, `await db.insert(t).values(r)`
        then: (ok?: (v: Row) => unknown, fail?: (e: unknown) => unknown) => plain().then(ok, fail),
        onConflictDoNothing: async () => {
          if (await this.#get(s, row)) return null;
          this.#write(s, row, null);
          return row;
        },
        onConflictDoUpdate: async (change: Row | ((r: Row) => Row)) => {
          const current = await this.#get(s, row);
          if (current === null) {
            this.#write(s, row, null);
            return row;
          }
          const next = { ...current, ...(typeof change === "function" ? change(current) : change) };
          this.#write(s, next, current);
          return next;
        },
      };
      return query;
    };

    return {
      find: (table, key) => this.#get(this.#state(table), key as Row) as never,
      insert: (table) => ({ values: (row) => insert(table, row as Row) as never }),
      update: (table, key) => ({
        set: async (change) => {
          const s = this.#state(table);
          const current = await this.#get(s, key as Row);
          if (current === null)
            throw new Error(`${s.info.name}: no row with key ${s.info.keyOf(key as Row)}`);
          const next = {
            ...current,
            ...(typeof change === "function" ? change(current as never) : change),
          };
          this.#write(s, next, current);
          return next as never;
        },
      }),
      delete: async (table, key) => {
        const s = this.#state(table);
        const current = await this.#get(s, key as Row);
        if (current === null) return false;
        const k = s.info.keyOf(current);
        this.#remember(s, k, current);
        const prior = s.pending.get(k);
        if (prior?.op === "insert") {
          s.pending.delete(k);
          s.pendingBytes -= approxBytes(prior.row);
        } else this.#pend(s, k, { op: "delete", row: current }, approxBytes(current));
        this.#cache(s, k, null);
        return true;
      },
    };
  }

  get pendingRows(): number {
    let n = 0;
    for (const s of this.#tables.values()) n += s.pending.size;
    return n;
  }

  /** Estimated bytes of the rows `flush` would write. */
  get pendingBytes(): number {
    let n = 0;
    for (const s of this.#tables.values()) n += s.pendingBytes;
    return n;
  }

  /**
   * Writes every buffered change with `client`, inside the caller's transaction. In journal mode, `block` tags the
   * pre-images written to the undo journal.
   */
  async flush(client: PoolClient, block?: number): Promise<void> {
    if (this.journal) {
      if (block === undefined) throw new Error("journal mode needs the block being flushed");
      await this.#writeJournal(client, block);
    }
    for (const s of this.#tables.values()) {
      if (s.pending.size === 0) continue;
      const inserts: Row[] = [];
      const upserts: Row[] = [];
      const deletes: Row[] = [];
      for (const p of s.pending.values())
        (p.op === "insert" ? inserts : p.op === "upsert" ? upserts : deletes).push(p.row);
      const table = quote(s.info.name);

      if (upserts.length > 0 || deletes.length > 0)
        await this.#addKey(s, (sql) => client.query(sql));
      if (deletes.length > 0) await this.#delete(client, s.info, deletes);
      if (inserts.length > 0) {
        try {
          await copyRows(client, s.info, table, inserts);
        } catch (e) {
          if (errorCode(e) === "23505")
            throw new ConfigError(
              `${s.info.name}: insert of a key that already exists (${(e as { detail?: string }).detail ?? "duplicate key"})`,
              { cause: e },
            );
          throw e;
        }
      }
      if (upserts.length > 0) {
        const temp = quote(`_kasbah_${s.info.name}`);
        await client.query(
          `CREATE TEMP TABLE IF NOT EXISTS ${temp} (LIKE ${table}) ON COMMIT DELETE ROWS`,
        );
        await copyRows(client, s.info, temp, upserts);
        const pk = s.info.primaryKey.map((c) => quote(c.column.name)).join(", ");
        const set = s.info.columns
          .filter((c) => !s.info.primaryKey.includes(c))
          .map((c) => `${quote(c.column.name)} = EXCLUDED.${quote(c.column.name)}`);
        const onConflict = set.length > 0 ? `DO UPDATE SET ${set.join(", ")}` : "DO NOTHING";
        await client.query(
          `INSERT INTO ${table} SELECT * FROM ${temp} ON CONFLICT (${pk}) ${onConflict}`,
        );
      }
      s.pending.clear();
      s.pendingBytes = 0;
    }
    this.#evict();
  }

  /** Past `maxCachedBytes`, drops rows oldest first from the tables read least, as Ponder evicts by reads. */
  #evict() {
    const tables = [...this.#tables.values()];
    let total = tables.reduce((n, s) => n + s.bytes, 0);
    if (total <= this.#maxCachedBytes) return;
    const target = this.#maxCachedBytes * CACHE_KEPT;
    for (const s of tables.sort((a, b) => a.hits - b.hits)) {
      for (const [k, row] of s.cache) {
        if (total <= target) break;
        const n = approxBytes(k) + approxBytes(row);
        s.cache.delete(k);
        s.bytes -= n;
        total -= n;
        s.complete = false;
      }
      if (total <= target) return;
    }
  }

  /** Tables still without their primary key. */
  get unkeyed(): number {
    let n = 0;
    for (const s of this.#tables.values()) if (!s.keyed) n++;
    return n;
  }

  /** Gives `table` its primary key, if it has none yet (before live mode: the journal and reverts need it). */
  addKey(table: PgTable, client: PoolClient): Promise<boolean> {
    return this.#addKey(this.#state(table), (sql) => client.query(sql));
  }

  async #addKey(s: State, query: (sql: string) => Promise<unknown>): Promise<boolean> {
    if (s.keyed) return false;
    try {
      for (const statement of primaryKeySql(s.info)) await query(statement);
    } catch (e) {
      if (errorCode(e) === "23505") {
        const detail = (e as { detail?: string }).detail ?? "duplicate key";
        throw new ConfigError(
          `${s.info.name}: a handler inserted a key twice (${detail}); fix the handler and run with reset`,
          { cause: e },
        );
      }
      throw e;
    }
    s.keyed = true;
    return true;
  }

  async #writeJournal(client: PoolClient, block: number) {
    const tables: string[] = [];
    const keys: string[] = [];
    const befores: (string | null)[] = [];
    for (const s of this.#tables.values()) {
      for (const [k, before] of s.before) {
        const row = before ?? s.cache.get(k);
        if (row === null || row === undefined) continue;
        tables.push(s.info.name);
        keys.push(JSON.stringify(driverValues(row, s.info.primaryKey)));
        befores.push(before === null ? null : JSON.stringify(driverValues(before, s.info.columns)));
      }
      s.before.clear();
    }
    if (tables.length === 0) return;
    await client.query(
      `INSERT INTO _kasbah_journal (block, tbl, pk, before)
       SELECT $1, t, k::jsonb, b::jsonb FROM unnest($2::text[], $3::text[], $4::text[]) WITH ORDINALITY AS u(t, k, b, i) ORDER BY i`,
      [block, tables, keys, befores],
    );
  }

  /**
   * Undoes every journaled block after `ancestor`, newest first, inside the caller's transaction, and drops the
   * caches: the database is the truth again.
   */
  async revert(client: PoolClient, ancestor: number): Promise<number> {
    const { rows } = await client.query<{
      tbl: string;
      pk: Record<string, unknown>;
      before: Record<string, unknown> | null;
    }>(`DELETE FROM _kasbah_journal WHERE block > $1 RETURNING tbl, pk, before, block, seq`, [
      ancestor,
    ]);
    const ordered = (
      rows as unknown as {
        tbl: string;
        pk: Record<string, unknown>;
        before: Record<string, unknown> | null;
        block: number;
        seq: string;
      }[]
    ).sort((a, b) => b.block - a.block || Number(BigInt(b.seq) - BigInt(a.seq)));
    const byName = new Map([...this.#tables.values()].map((s) => [s.info.name, s]));
    for (const r of ordered) {
      const s = byName.get(r.tbl);
      if (s === undefined) throw new Error(`journal names unknown table ${r.tbl}`);
      const info = s.info;
      const pkCols = info.primaryKey.map((c) => c.column.name);
      if (r.before === null) {
        const where = pkCols.map((c, i) => `${quote(c)} = $${i + 1}`).join(" AND ");
        await client.query(
          `DELETE FROM ${quote(info.name)} WHERE ${where}`,
          pkCols.map((c) => r.pk[c]),
        );
      } else {
        // ON CONFLICT needs the key: a restart reverts before the keys phase, and a table may have lost it.
        await this.#addKey(s, (sql) => client.query(sql));
        const cols = info.columns.map((c) => c.column.name);
        const set = cols
          .filter((c) => !pkCols.includes(c))
          .map((c) => `${quote(c)} = EXCLUDED.${quote(c)}`);
        await client.query(
          `INSERT INTO ${quote(info.name)} (${cols.map(quote).join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})
           ON CONFLICT (${pkCols.map(quote).join(", ")}) ${set.length > 0 ? `DO UPDATE SET ${set.join(", ")}` : "DO NOTHING"}`,
          cols.map((c) => r.before![c]),
        );
      }
    }
    for (const s of this.#tables.values()) {
      s.cache.clear();
      s.bytes = 0;
      s.pending.clear();
      s.pendingBytes = 0;
      s.before.clear();
      s.complete = false;
    }
    return ordered.length;
  }

  async #delete(client: PoolClient, info: TableInfo, rows: Row[]) {
    const cols = info.primaryKey.map((c) => quote(c.column.name)).join(", ");
    for (const part of chunks(rows, ROWS_PER_DELETE)) {
      const params: unknown[] = [];
      const tuples = part.map((row) => {
        const placeholders = info.primaryKey.map((c) => {
          params.push(c.column.mapToDriverValue(row[c.key]));
          return `$${params.length}`;
        });
        return `(${placeholders.join(", ")})`;
      });
      await client.query(
        `DELETE FROM ${quote(info.name)} WHERE (${cols}) IN (${tuples.join(", ")})`,
        params,
      );
    }
  }
}
