import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type pg from "pg";
import { from as copyFrom } from "pg-copy-streams";
import { quote } from "./db/table.ts";
import type { EmittedEvent, Receipt, Transaction } from "./rpc/methods.ts";
import type { Batch } from "./sync/fetch.ts";

const hexBytes = (felt: string): Buffer => {
  let h = BigInt(felt).toString(16);
  if (h === "0") return Buffer.alloc(0);
  if (h.length % 2 === 1) h = `0${h}`;
  return Buffer.from(h, "hex");
};
/** Minimal big-endian bytes, as hex, to a felt: only the first nibble can be a zero to drop. */
const hexFelt = (h: string): string => (h.length === 0 ? "0x0" : h.charCodeAt(0) === 48 ? `0x${h.slice(1)}` : `0x${h}`);
const felt = (b: Buffer): string => hexFelt(b.toString("hex"));

/** Felts as one bytea: per felt, a length byte then its minimal big-endian bytes. */
export function packFelts(felts: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  for (const f of felts) {
    const b = hexBytes(f);
    parts.push(Buffer.from([b.length]), b);
  }
  return Buffer.concat(parts);
}

export function unpackFelts(b: Buffer): string[] {
  return unpackHex(b.toString("hex"));
}

/** `unpackFelts` from the bytea's hex text, as Postgres' `encode(x, 'hex')` returns it. */
export function unpackHex(h: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < h.length; ) {
    const n = Number.parseInt(h.slice(i, i + 2), 16) * 2;
    out.push(hexFelt(h.slice(i + 2, i + 2 + n)));
    i += 2 + n;
  }
  return out;
}

const SCHEMA_SQL = (s: string) => [
  `CREATE SCHEMA IF NOT EXISTS ${s}`,
  `CREATE TABLE IF NOT EXISTS ${s}.events (block integer NOT NULL, tx integer NOT NULL, idx integer NOT NULL, address bytea NOT NULL,
     selector bytea NOT NULL, block_hash bytea NOT NULL, tx_hash bytea NOT NULL, keys bytea NOT NULL, data bytea NOT NULL, PRIMARY KEY (block, tx, idx))`,
  `CREATE TABLE IF NOT EXISTS ${s}.coverage (address bytea NOT NULL, selector bytea NOT NULL, ranges int8multirange NOT NULL, PRIMARY KEY (address, selector))`,
  `CREATE TABLE IF NOT EXISTS ${s}.calls (address bytea NOT NULL, entrypoint bytea NOT NULL, calldata bytea NOT NULL, block integer NOT NULL,
     result bytea NOT NULL, seq bigserial, PRIMARY KEY (address, entrypoint, calldata, block))`,
  `ALTER TABLE ${s}.calls ADD COLUMN IF NOT EXISTS seq bigserial`,
  `CREATE INDEX IF NOT EXISTS calls_seq ON ${s}.calls (seq)`,
  `CREATE TABLE IF NOT EXISTS ${s}.transactions (hash bytea PRIMARY KEY, block integer NOT NULL, transaction jsonb, receipt jsonb)`,
  `CREATE TABLE IF NOT EXISTS ${s}.headers (block integer PRIMARY KEY, hash bytea NOT NULL, parent bytea NOT NULL, timestamp bigint NOT NULL)`,
];

const bytea = (b: Buffer) => `\\\\x${b.toString("hex")}`;

/**
 * Final events (below the reorg window) kept in Postgres, shared by every app on the same database and chain.
 * `coverage` says which blocks are complete for each (address, selector at key 0); a re-index reads those from
 * here and fetches only the rest.
 */
export class EventCache {
  readonly #pool: pg.Pool;
  readonly #schema: string;
  /** Events fetched from RPC since the last `persist`, and the first block they cover. */
  #pending: EmittedEvent[] = [];
  #pendingFrom: number | undefined;
  #pendingPairs: { addresses: string[]; selectors: string[] } | undefined;
  /** As JSON text: far smaller than the parsed objects while they wait for the commit. */
  #transactions: { hash: Buffer; block: number; transaction: string | null; receipt: string | null }[] = [];
  #calls: { address: Buffer; entrypoint: Buffer; calldata: Buffer; block: number; result: Buffer }[] = [];
  stats = { cachedEvents: 0, fetchedEvents: 0 };
  #pendingBytes = 0;
  readonly #maxCalls: number;
  /** Rows in `calls`, counted at open and kept up to date by this process (other apps add to it too). */
  #callRows = 0;

  private constructor(pool: pg.Pool, schema: string, maxCalls: number) {
    this.#pool = pool;
    this.#schema = schema;
    this.#maxCalls = maxCalls;
  }

  /** `maxCalls`: call results kept; past it the oldest are dropped down to 90%. Default 1M. */
  static async open(pool: pg.Pool, chainId: string, o: { maxCalls?: number } = {}): Promise<EventCache> {
    const schema = quote(`kasbah_cache_${chainId.toLowerCase()}`);
    for (const sql of SCHEMA_SQL(schema)) await pool.query(sql);
    const cache = new EventCache(pool, schema, o.maxCalls ?? 1_000_000);
    cache.#callRows = Number((await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${schema}.calls`)).rows[0]!.n);
    await cache.#pruneCalls(pool);
    return cache;
  }

  async #pruneCalls(q: pg.Pool | pg.PoolClient) {
    if (this.#callRows <= this.#maxCalls) return;
    const drop = this.#callRows - Math.floor(this.#maxCalls * 0.9);
    const r = await q.query(`DELETE FROM ${this.#schema}.calls WHERE seq IN (SELECT seq FROM ${this.#schema}.calls ORDER BY seq LIMIT $1)`, [drop]);
    this.#callRows -= r.rowCount ?? 0;
  }

  /** Every chain's cache in the database, with its size. */
  static async info(pool: pg.Pool): Promise<{ schema: string; events: number; calls: number; transactions: number; headers: number; bytes: number }[]> {
    const { rows } = await pool.query<{ schema: string; bytes: string }>(
      `SELECT n.nspname AS schema, coalesce(sum(pg_total_relation_size(c.oid)), 0)::text AS bytes FROM pg_namespace n
       LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relkind = 'r' WHERE n.nspname LIKE 'kasbah\\_cache\\_%' GROUP BY 1 ORDER BY 1`,
    );
    const out = [];
    for (const r of rows) {
      const s = quote(r.schema);
      // A cache made by an older version may lack a table.
      const n = async (t: string) => {
        const exists = (await pool.query(`SELECT to_regclass($1) AS r`, [`${s}.${t}`])).rows[0].r !== null;
        return exists ? Number((await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${s}.${t}`)).rows[0]!.n) : 0;
      };
      out.push({ schema: r.schema, events: await n("events"), calls: await n("calls"), transactions: await n("transactions"), headers: await n("headers"), bytes: Number(r.bytes) });
    }
    return out;
  }

  /** Empties a chain's cache (or every chain's): events with their coverage and headers, call results, or both. */
  static async clear(pool: pg.Pool, what: { events?: boolean; calls?: boolean }, chainId?: string) {
    for (const { schema } of await EventCache.info(pool)) {
      if (chainId !== undefined && schema !== `kasbah_cache_${chainId.toLowerCase()}`) continue;
      const s = quote(schema);
      if (what.events) await pool.query(`TRUNCATE ${s}.events, ${s}.coverage, ${s}.headers`);
      if (what.events && (await pool.query(`SELECT to_regclass($1) AS r`, [`${s}.transactions`])).rows[0].r !== null) await pool.query(`TRUNCATE ${s}.transactions`);
      if (what.calls && (await pool.query(`SELECT to_regclass($1) AS r`, [`${s}.calls`])).rows[0].r !== null) await pool.query(`TRUNCATE ${s}.calls`);
    }
  }

  /** First block from `from` not covered for every (address, selector) pair. */
  async coveredUntil(addresses: string[], selectors: string[], from: number): Promise<number> {
    if (addresses.length === 0 || selectors.length === 0) return from;
    const a: Buffer[] = [];
    const s: Buffer[] = [];
    for (const x of addresses) for (const y of selectors) {
      a.push(hexBytes(x));
      s.push(hexBytes(y));
    }
    const { rows } = await this.#pool.query<{ end: string }>(
      `SELECT min(coalesce(x.up, $1::int8))::text AS end FROM unnest($2::bytea[], $3::bytea[]) AS p(address, selector)
       LEFT JOIN LATERAL (SELECT upper(r) AS up FROM ${this.#schema}.coverage c, unnest(c.ranges) r
                          WHERE c.address = p.address AND c.selector = p.selector AND r @> $1::int8) x ON true`,
      [from, a, s],
    );
    return Number(rows[0]!.end);
  }

  /**
   * Cached events of `addresses` × `selectors` in `[from, to]`, in chain order, at most about `limit` per batch:
   * paged by position, and a batch never ends inside a block.
   */
  async *read(addresses: string[], selectors: string[], from: number, to: number, limit = 50_000): AsyncGenerator<Batch> {
    const a = addresses.map(hexBytes);
    const s = selectors.map(hexBytes);
    // Hex text straight from Postgres: no Buffer round trip.
    type Row = { block: number; tx: number; idx: number; address: string; block_hash: string; tx_hash: string; keys: string; data: string };
    const query = async (lo: number, hi: number, n: number | null) =>
      (await this.#pool.query<Row>(
        `SELECT block, tx, idx, encode(address, 'hex') AS address, encode(block_hash, 'hex') AS block_hash, encode(tx_hash, 'hex') AS tx_hash,
                encode(keys, 'hex') AS keys, encode(data, 'hex') AS data FROM ${this.#schema}.events
         WHERE block BETWEEN $1 AND $2 AND address = ANY($3) AND selector = ANY($4) ORDER BY block, tx, idx LIMIT $5`,
        [lo, hi, a, s, n],
      )).rows;
    /** The events from `lo` up to a block boundary, and the last complete block. */
    const page = async (lo: number): Promise<{ rows: Row[]; through: number }> => {
      const rows = await query(lo, to, limit);
      if (rows.length < limit) return { rows, through: to };
      const last = rows.at(-1)!.block;
      // One block with more than `limit` events: take it whole.
      if (rows[0]!.block === last) return { rows: await query(last, last, null), through: last };
      return { rows: rows.filter((r) => r.block < last), through: last - 1 };
    };
    let next = page(from);
    for (;;) {
      const { rows, through } = await next;
      if (through < to) next = page(through + 1);
      const events: EmittedEvent[] = rows.map((r) => ({
        from_address: hexFelt(r.address),
        keys: unpackHex(r.keys),
        data: unpackHex(r.data),
        block_number: r.block,
        block_hash: hexFelt(r.block_hash),
        transaction_hash: hexFelt(r.tx_hash),
        transaction_index: r.tx,
        event_index: r.idx,
      }));
      this.stats.cachedEvents += events.length;
      yield { events, through };
      if (through >= to) return;
    }
  }

  /** Remembers events fetched from RPC for `addresses` × `selectors` from block `from`, until `persist`. */
  track(addresses: string[], selectors: string[], from: number) {
    this.#pendingPairs = { addresses: [...addresses], selectors: [...selectors] };
    this.#pendingFrom = from;
    this.#pending = [];
  }

  add(events: EmittedEvent[]) {
    if (this.#pendingFrom === undefined) return;
    for (const e of events) this.#pending.push(e);
    this.stats.fetchedEvents += events.length;
  }

  /** A cached `starknet_call` result at a final block. */
  async getCall(address: string, entrypoint: string, calldata: string[], block: number): Promise<string[] | undefined> {
    const { rows } = await this.#pool.query<{ result: string }>(
      `SELECT encode(result, 'hex') AS result FROM ${this.#schema}.calls WHERE address = $1 AND entrypoint = $2 AND calldata = $3 AND block = $4`,
      [hexBytes(address), hexBytes(entrypoint), packFelts(calldata), block],
    );
    return rows[0] === undefined ? undefined : unpackHex(rows[0].result);
  }

  /** Keeps a call result until the next `persist`. */
  rememberCall(address: string, entrypoint: string, calldata: string[], block: number, result: string[]) {
    this.#calls.push({ address: hexBytes(address), entrypoint: hexBytes(entrypoint), calldata: packFelts(calldata), block, result: packFelts(result) });
  }

  /** Transaction and receipt JSON waiting for the next `persist`: the caller commits early past a limit. */
  get pendingBytes(): number {
    return this.#pendingBytes;
  }

  /** Cached transactions and receipts by hash (either may be missing). */
  async transactions(hashes: string[]): Promise<Map<string, { transaction?: Transaction; receipt?: Receipt }>> {
    const { rows } = await this.#pool.query<{ hash: string; transaction: Transaction | null; receipt: Receipt | null }>(
      `SELECT encode(hash, 'hex') AS hash, transaction, receipt FROM ${this.#schema}.transactions WHERE hash = ANY($1)`,
      [hashes.map(hexBytes)],
    );
    return new Map(rows.map((r) => [hexFelt(r.hash), { ...(r.transaction === null ? {} : { transaction: r.transaction }), ...(r.receipt === null ? {} : { receipt: r.receipt }) }]));
  }

  /** Keeps a fetched transaction and/or receipt until the next `persist`. */
  rememberTransaction(hash: string, block: number, x: { transaction?: Transaction; receipt?: Receipt }) {
    const transaction = x.transaction === undefined ? null : JSON.stringify(x.transaction);
    const receipt = x.receipt === undefined ? null : JSON.stringify(x.receipt);
    this.#pendingBytes += (transaction?.length ?? 0) + (receipt?.length ?? 0);
    this.#transactions.push({
      hash: hexBytes(hash),
      block,
      transaction,
      receipt,
    });
  }

  /** Writes the tracked events and calls, and marks `[from, through]` covered, inside the caller's transaction. */
  async persist(tx: pg.PoolClient, through: number) {
    const all = this.#transactions;
    this.#transactions = [];
    this.#pendingBytes = 0;
    // In chunks: one statement's array parameters are built as one string.
    for (let i = 0; i < all.length; i += 1_000) {
      const t = all.slice(i, i + 1_000);
      await tx.query(
        `INSERT INTO ${this.#schema}.transactions SELECT * FROM unnest($1::bytea[], $2::int[], $3::jsonb[], $4::jsonb[])
         ON CONFLICT (hash) DO UPDATE SET transaction = coalesce(EXCLUDED.transaction, transactions.transaction), receipt = coalesce(EXCLUDED.receipt, transactions.receipt)`,
        [t.map((x) => x.hash), t.map((x) => x.block), t.map((x) => x.transaction), t.map((x) => x.receipt)],
      );
    }
    if (this.#calls.length > 0) {
      const c = this.#calls;
      this.#calls = [];
      const r = await tx.query(
        `INSERT INTO ${this.#schema}.calls (address, entrypoint, calldata, block, result)
         SELECT * FROM unnest($1::bytea[], $2::bytea[], $3::bytea[], $4::int[], $5::bytea[]) ON CONFLICT DO NOTHING`,
        [c.map((x) => x.address), c.map((x) => x.entrypoint), c.map((x) => x.calldata), c.map((x) => x.block), c.map((x) => x.result)],
      );
      this.#callRows += r.rowCount ?? 0;
      await this.#pruneCalls(tx);
    }
    const from = this.#pendingFrom;
    const pairs = this.#pendingPairs;
    if (from === undefined || pairs === undefined || through < from) return;
    if (this.#pending.length > 0) {
      await tx.query(`CREATE TEMP TABLE IF NOT EXISTS _kasbah_cache_in (LIKE ${this.#schema}.events) ON COMMIT DELETE ROWS`);
      const lines = (function* (events: EmittedEvent[]) {
        let chunk = "";
        for (const e of events) {
          chunk += `${e.block_number}\t${e.transaction_index}\t${e.event_index}\t${bytea(hexBytes(e.from_address))}\t${bytea(hexBytes(e.keys[0] ?? "0x0"))}\t${bytea(hexBytes(e.block_hash ?? "0x0"))}\t${bytea(hexBytes(e.transaction_hash))}\t${bytea(packFelts(e.keys))}\t${bytea(packFelts(e.data))}\n`;
          if (chunk.length > 1 << 16) {
            yield chunk;
            chunk = "";
          }
        }
        if (chunk !== "") yield chunk;
      })(this.#pending);
      await pipeline(Readable.from(lines), tx.query(copyFrom(`COPY _kasbah_cache_in FROM STDIN`)));
      await tx.query(`INSERT INTO ${this.#schema}.events SELECT * FROM _kasbah_cache_in ON CONFLICT DO NOTHING`);
    }
    const a: Buffer[] = [];
    const s: Buffer[] = [];
    for (const x of pairs.addresses) for (const y of pairs.selectors) {
      a.push(hexBytes(x));
      s.push(hexBytes(y));
    }
    await tx.query(
      `INSERT INTO ${this.#schema}.coverage (address, selector, ranges)
       SELECT address, selector, int8multirange(int8range($1, $2)) FROM unnest($3::bytea[], $4::bytea[]) AS p(address, selector)
       ON CONFLICT (address, selector) DO UPDATE SET ranges = coverage.ranges + EXCLUDED.ranges`,
      [from, through + 1, a, s],
    );
    this.#pending = [];
    this.#pendingFrom = through + 1;
  }

  /** Stops tracking (the rest of the range is live, or the run stopped). */
  untrack() {
    this.#pendingFrom = undefined;
    this.#pendingPairs = undefined;
    this.#pending = [];
  }

  async headers(numbers: number[]): Promise<Map<number, { hash: string; parent: string; timestamp: number }>> {
    const { rows } = await this.#pool.query<{ block: number; hash: Buffer; parent: Buffer; timestamp: string }>(
      `SELECT block, hash, parent, timestamp FROM ${this.#schema}.headers WHERE block = ANY($1)`,
      [numbers],
    );
    return new Map(rows.map((r) => [r.block, { hash: felt(r.hash), parent: felt(r.parent), timestamp: Number(r.timestamp) }]));
  }

  async saveHeaders(headers: { block_number: number; block_hash: string; parent_hash: string; timestamp: number }[]) {
    if (headers.length === 0) return;
    await this.#pool.query(
      `INSERT INTO ${this.#schema}.headers SELECT * FROM unnest($1::int[], $2::bytea[], $3::bytea[], $4::int8[]) ON CONFLICT DO NOTHING`,
      [headers.map((h) => h.block_number), headers.map((h) => hexBytes(h.block_hash)), headers.map((h) => hexBytes(h.parent_hash)), headers.map((h) => h.timestamp)],
    );
  }
}
