import { and, eq, type InferInsertModel, type InferSelectModel } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgTable } from "drizzle-orm/pg-core";
import type { PoolClient } from "pg";
import { copyRows } from "./copy.ts";
import { quote, type Row, type TableInfo, tableInfo } from "./table.ts";

/** How a buffered row reaches the database at flush. */
type Pending = { op: "insert" | "upsert"; row: Row } | { op: "delete"; row: Row };

type State = {
  info: TableInfo;
  cache: Map<string, Row | null>;
  /** Every row is in `cache`: a miss means the row doesn't exist. True on a fresh run until the cache is evicted. */
  complete: boolean;
  pending: Map<string, Pending>;
};

export type StoreOptions = { complete: boolean; maxCachedRows?: number };

type Key<T extends PgTable> = Partial<InferSelectModel<T>>;
type Values<T extends PgTable> = InferInsertModel<T>;
type Selected<T extends PgTable> = InferSelectModel<T>;

/** The handler-facing database: reads and writes go to memory, `flush` writes them out in one transaction. */
export type Db = {
  find<T extends PgTable>(table: T, key: Key<T>): Promise<Selected<T> | null>;
  insert<T extends PgTable>(table: T): {
    values(row: Values<T>): InsertQuery<T>;
  };
  update<T extends PgTable>(table: T, key: Key<T>): {
    set(change: Partial<Values<T>> | ((row: Selected<T>) => Partial<Values<T>>)): Promise<Selected<T>>;
  };
  delete<T extends PgTable>(table: T, key: Key<T>): Promise<boolean>;
};

export type InsertQuery<T extends PgTable> = PromiseLike<Selected<T>> & {
  onConflictDoNothing(): Promise<Selected<T> | null>;
  onConflictDoUpdate(change: Partial<Values<T>> | ((row: Selected<T>) => Partial<Values<T>>)): Promise<Selected<T>>;
};

export class Store {
  readonly db: Db;
  readonly #tables = new Map<PgTable, State>();
  readonly #orm: NodePgDatabase;
  readonly #maxCachedRows: number;

  constructor(orm: NodePgDatabase, tables: PgTable[], options: StoreOptions) {
    this.#orm = orm;
    this.#maxCachedRows = options.maxCachedRows ?? 500_000;
    for (const t of tables) {
      this.#tables.set(t, { info: tableInfo(t), cache: new Map(), complete: options.complete, pending: new Map() });
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
    if (cached !== undefined) return cached;
    if (s.complete) return null;
    const where = and(...s.info.primaryKey.map((c) => eq(c.column, key[c.key])));
    const [row] = await this.#orm.select().from(s.info.table).where(where).limit(1);
    s.cache.set(k, (row as Row | undefined) ?? null);
    return (row as Row | undefined) ?? null;
  }

  #write(s: State, row: Row, existed: boolean) {
    const k = s.info.keyOf(row);
    const before = s.pending.get(k)?.op;
    // A row inserted this batch never reached the database; one deleted or upserted this batch may be there.
    const op = before === "insert" ? "insert" : before !== undefined || existed ? "upsert" : "insert";
    s.pending.set(k, { op, row });
    s.cache.set(k, row);
  }

  #createDb(): Db {
    const insert = (table: PgTable, values: Row) => {
      const s = this.#state(table);
      const k = s.info.keyOf(values);
      const row = { ...values };
      const plain = async () => {
        if (s.cache.get(k)) throw new Error(`${s.info.name}: a row with key ${k} already exists`);
        this.#write(s, row, false);
        return row;
      };
      const query = {
        then: (ok?: (v: Row) => unknown, fail?: (e: unknown) => unknown) => plain().then(ok, fail),
        onConflictDoNothing: async () => {
          if (await this.#get(s, row)) return null;
          this.#write(s, row, false);
          return row;
        },
        onConflictDoUpdate: async (change: Row | ((r: Row) => Row)) => {
          const current = await this.#get(s, row);
          if (current === null) {
            this.#write(s, row, false);
            return row;
          }
          const next = { ...current, ...(typeof change === "function" ? change(current) : change) };
          this.#write(s, next, true);
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
          if (current === null) throw new Error(`${s.info.name}: no row with key ${s.info.keyOf(key as Row)}`);
          const next = { ...current, ...(typeof change === "function" ? change(current as never) : change) };
          this.#write(s, next, true);
          return next as never;
        },
      }),
      delete: async (table, key) => {
        const s = this.#state(table);
        const current = await this.#get(s, key as Row);
        if (current === null) return false;
        const k = s.info.keyOf(current);
        if (s.pending.get(k)?.op === "insert") s.pending.delete(k);
        else s.pending.set(k, { op: "delete", row: current });
        s.cache.set(k, null);
        return true;
      },
    };
  }

  get pendingRows(): number {
    let n = 0;
    for (const s of this.#tables.values()) n += s.pending.size;
    return n;
  }

  /** Writes every buffered change with `client`, inside the caller's transaction. */
  async flush(client: PoolClient): Promise<void> {
    for (const s of this.#tables.values()) {
      if (s.pending.size === 0) continue;
      const inserts: Row[] = [];
      const upserts: Row[] = [];
      const deletes: Row[] = [];
      for (const p of s.pending.values()) (p.op === "insert" ? inserts : p.op === "upsert" ? upserts : deletes).push(p.row);
      const table = quote(s.info.name);

      if (deletes.length > 0) await this.#delete(client, s.info, deletes);
      if (inserts.length > 0) await copyRows(client, s.info, table, inserts);
      if (upserts.length > 0) {
        const temp = quote(`_kasbah_${s.info.name}`);
        await client.query(`CREATE TEMP TABLE IF NOT EXISTS ${temp} (LIKE ${table}) ON COMMIT DELETE ROWS`);
        await copyRows(client, s.info, temp, upserts);
        const pk = s.info.primaryKey.map((c) => quote(c.column.name)).join(", ");
        const set = s.info.columns
          .filter((c) => !s.info.primaryKey.includes(c))
          .map((c) => `${quote(c.column.name)} = EXCLUDED.${quote(c.column.name)}`);
        const onConflict = set.length > 0 ? `DO UPDATE SET ${set.join(", ")}` : "DO NOTHING";
        await client.query(`INSERT INTO ${table} SELECT * FROM ${temp} ON CONFLICT (${pk}) ${onConflict}`);
      }
      s.pending.clear();
      if (s.cache.size > this.#maxCachedRows) {
        s.cache.clear();
        s.complete = false;
      }
    }
  }

  async #delete(client: PoolClient, info: TableInfo, rows: Row[]) {
    const cols = info.primaryKey.map((c) => quote(c.column.name)).join(", ");
    for (let i = 0; i < rows.length; i += 1000) {
      const params: unknown[] = [];
      const tuples = rows.slice(i, i + 1000).map((row) => {
        const placeholders = info.primaryKey.map((c) => {
          params.push(c.column.mapToDriverValue(row[c.key]));
          return `$${params.length}`;
        });
        return `(${placeholders.join(", ")})`;
      });
      await client.query(`DELETE FROM ${quote(info.name)} WHERE (${cols}) IN (${tuples.join(", ")})`, params);
    }
  }
}
