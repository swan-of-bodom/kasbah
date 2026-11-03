import type pg from "pg";
import { DEFAULTS } from "../config/resolve.ts";
import type { BlockHeader, EmittedEvent } from "../rpc/methods.ts";
import type { RawExtras } from "../sync/extras.ts";
import type { Batch } from "../sync/fetch.ts";
import { type Block, blockOf } from "../types/block.ts";
import type { RawReceipt, RawTransaction } from "../types/transaction.ts";
import { chunks } from "../utils/chunks.ts";
import { copyLines } from "./copy.ts";
import { quote } from "./table.ts";

export function feltHex(felt: string): string {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(felt)) throw new Error(`not a felt: ${felt}`);
  let i = 2;
  while (i < felt.length && felt.charCodeAt(i) === 48) i++;
  const h = felt.slice(i).toLowerCase();
  return h.length % 2 === 1 ? `0${h}` : h;
}
const feltBytes = (felt: string): Buffer => Buffer.from(feltHex(felt), "hex");
const feltFromMinimalBytes = (h: string): string =>
  h.length === 0 ? "0x0" : h.charCodeAt(0) === 48 ? `0x${h.slice(1)}` : `0x${h}`;

/** Felts as one bytea: per felt, a length byte then its minimal big-endian bytes. */
export function packFelts(felts: readonly string[]): Buffer {
  return Buffer.from(packFeltsHex(felts), "hex");
}

export function packFeltsHex(felts: readonly string[]): string {
  let out = "";
  for (const f of felts) {
    const h = feltHex(f);
    out += (h.length / 2).toString(16).padStart(2, "0") + h;
  }
  return out;
}

export function unpackFelts(b: Buffer): string[] {
  return unpackHex(b.toString("hex"));
}

/** A lowercase hex digit's value. */
const nibble = (c: number) => (c < 97 ? c - 48 : c - 87);

/**
 * `unpackFelts` from the bytea's hex text, as Postgres' `encode(x, 'hex')` returns it (lowercase). Each length
 * byte is read from its two characters' codes: slicing it out for `parseInt` cost ~40% more per felt.
 */
export function unpackHex(h: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < h.length; ) {
    const n = (nibble(h.charCodeAt(i)) * 16 + nibble(h.charCodeAt(i + 1))) * 2;
    out.push(feltFromMinimalBytes(h.slice(i + 2, i + 2 + n)));
    i += 2 + n;
  }
  return out;
}

/** Transactions per INSERT: one statement's array parameters are built as one string. */
const ROWS_PER_INSERT = 1_000;
/** Share of `maxCalls` left after pruning, so the next inserts don't prune again at once. */
const CALLS_KEPT = 0.9;

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
  `ALTER TABLE ${s}.headers ADD COLUMN IF NOT EXISTS header jsonb`,
];

/** A packed felt's length byte as two hex digits, by byte count (a felt has at most 32). */
const LENGTH_BYTE = Array.from({ length: 33 }, (_, n) => n.toString(16).padStart(2, "0"));

/**
 * `feltHex` for COPY lines, with only the prefix and length checked: Postgres rejects any other digit when it decodes
 * the bytea. Checking every digit here took ~70% of building an event's line.
 */
function copyHex(felt: string): string {
  if (
    felt.length < 3 ||
    felt.length > 66 ||
    felt.charCodeAt(0) !== 48 ||
    felt.charCodeAt(1) !== 120
  )
    throw new Error(`not a felt: ${felt}`);
  let i = 2;
  while (i < felt.length && felt.charCodeAt(i) === 48) i++;
  return (felt.length - i) % 2 === 1 ? `0${felt.slice(i)}` : felt.slice(i);
}

/** `packFeltsHex` for COPY lines (see `copyHex`). */
export function packCopyHex(felts: readonly string[]): string {
  let out = "";
  for (const f of felts) {
    const h = copyHex(f);
    out += LENGTH_BYTE[h.length >> 1] + h;
  }
  return out;
}

const eventLine = (e: EmittedEvent) =>
  `${e.block_number}\t${e.transaction_index}\t${e.event_index}\t\\\\x${copyHex(e.from_address)}\t\\\\x${copyHex(e.keys[0] ?? "0x0")}\t\\\\x${copyHex(e.block_hash ?? "0x0")}\t\\\\x${copyHex(e.transaction_hash)}\t\\\\x${packCopyHex(e.keys)}\t\\\\x${packCopyHex(e.data)}\n`;

/** Postgres' code for a duplicate key. */
const UNIQUE_VIOLATION = "23505";

type Pairs = { addresses: string[]; selectors: string[] };
type CachedTransaction = {
  hash: Buffer;
  block: number;
  transaction: string | null;
  receipt: string | null;
};
type CachedCall = {
  address: Buffer;
  entrypoint: Buffer;
  calldata: Buffer;
  block: number;
  result: Buffer;
};
/** Events fetched for `pairs` in blocks `[from, to]`, not yet written. */
type Tracked = { pairs: Pairs; from: number; to: number; events: EmittedEvent[] };
/** One commit's share: what was fetched until it started, and the tracked blocks it covers. */
type Taken = { transactions: CachedTransaction[]; calls: CachedCall[]; ranges: Tracked[] };

/**
 * Final events (below the reorg window) kept in Postgres, shared by every app on the same database and chain.
 * `coverage` says which blocks are complete for each (address, selector at key 0); a re-index reads those from
 * here and fetches only the rest.
 */
export class EventCache {
  readonly #pool: pg.Pool;
  readonly #schema: string;
  /**
   * Ranges being fetched, oldest first. One stays until commits have passed all of its blocks: the next range
   * (a contract's start block) begins while its last blocks are still being handled.
   */
  #tracked: Tracked[] = [];
  #transactions: CachedTransaction[] = [];
  #calls: CachedCall[] = [];
  stats = { cachedEvents: 0, fetchedEvents: 0 };
  #pendingBytes = 0;
  /** What `take` moved out for the commit in flight, until its `persist`. */
  #taken: Taken | undefined;
  readonly #maxCalls: number;
  /** A write found events already cached (a range fetched again for a new selector): later ones skip duplicates. */
  #overlaps = false;
  #callRows = 0;

  private constructor(pool: pg.Pool, schema: string, maxCalls: number) {
    this.#pool = pool;
    this.#schema = schema;
    this.#maxCalls = maxCalls;
  }

  /** `maxCalls`: call results kept; past it the oldest are dropped down to 90%. Default 1M. */
  static async open(
    pool: pg.Pool,
    chainId: string,
    o: { maxCalls?: number } = {},
  ): Promise<EventCache> {
    const schema = quote(`kasbah_cache_${chainId.toLowerCase()}`);
    for (const sql of SCHEMA_SQL(schema)) await pool.query(sql);
    const cache = new EventCache(pool, schema, o.maxCalls ?? DEFAULTS.maxCalls);
    cache.#callRows = Number(
      (await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${schema}.calls`)).rows[0]!.n,
    );
    await cache.#pruneCalls(pool);
    return cache;
  }

  async #pruneCalls(q: pg.Pool | pg.PoolClient) {
    if (this.#callRows <= this.#maxCalls) return;
    const drop = this.#callRows - Math.floor(this.#maxCalls * CALLS_KEPT);
    const r = await q.query(
      `DELETE FROM ${this.#schema}.calls WHERE seq IN (SELECT seq FROM ${this.#schema}.calls ORDER BY seq LIMIT $1)`,
      [drop],
    );
    this.#callRows -= r.rowCount ?? 0;
  }

  /** Every chain's cache in the database (or one chain's), with its size. */
  static async info(
    pool: pg.Pool,
    chainId?: string,
  ): Promise<
    {
      schema: string;
      events: number;
      calls: number;
      transactions: number;
      headers: number;
      bytes: number;
    }[]
  > {
    const { rows } = await pool.query<{ schema: string; bytes: string }>(
      `SELECT n.nspname AS schema, coalesce(sum(pg_total_relation_size(c.oid)), 0)::text AS bytes FROM pg_namespace n
       LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relkind = 'r' WHERE n.nspname LIKE 'kasbah\\_cache\\_%' GROUP BY 1 ORDER BY 1`,
    );
    const out = [];
    for (const r of rows) {
      if (chainId !== undefined && r.schema !== `kasbah_cache_${chainId.toLowerCase()}`) continue;
      const s = quote(r.schema);
      const n = async (t: string) => {
        const exists =
          (await pool.query(`SELECT to_regclass($1) AS r`, [`${s}.${t}`])).rows[0].r !== null;
        return exists
          ? Number(
              (await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${s}.${t}`)).rows[0]!.n,
            )
          : 0;
      };
      out.push({
        schema: r.schema,
        events: await n("events"),
        calls: await n("calls"),
        transactions: await n("transactions"),
        headers: await n("headers"),
        bytes: Number(r.bytes),
      });
    }
    return out;
  }

  /** Empties a chain's cache (or every chain's): events with their coverage and headers, call results, or both. */
  static async clear(pool: pg.Pool, what: { events?: boolean; calls?: boolean }, chainId?: string) {
    for (const { schema } of await EventCache.info(pool, chainId)) {
      const s = quote(schema);
      if (what.events) await pool.query(`TRUNCATE ${s}.events, ${s}.coverage, ${s}.headers`);
      if (
        what.events &&
        (await pool.query(`SELECT to_regclass($1) AS r`, [`${s}.transactions`])).rows[0].r !== null
      )
        await pool.query(`TRUNCATE ${s}.transactions`);
      if (
        what.calls &&
        (await pool.query(`SELECT to_regclass($1) AS r`, [`${s}.calls`])).rows[0].r !== null
      )
        await pool.query(`TRUNCATE ${s}.calls`);
    }
  }

  /** First block from `from` not covered for every (address, selector) pair. */
  async coveredUntil(addresses: string[], selectors: string[], from: number): Promise<number> {
    if (addresses.length === 0 || selectors.length === 0) return from;
    const a: Buffer[] = [];
    const s: Buffer[] = [];
    for (const x of addresses)
      for (const y of selectors) {
        a.push(feltBytes(x));
        s.push(feltBytes(y));
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
  async *read(
    addresses: string[],
    selectors: string[],
    from: number,
    to: number,
    limit = 12_000,
  ): AsyncGenerator<Batch> {
    const a = addresses.map(feltBytes);
    const s = selectors.map(feltBytes);
    type Row = {
      block: number;
      tx: number;
      idx: number;
      address: string;
      block_hash: string;
      tx_hash: string;
      keys: string;
      data: string;
    };
    const query = async (lo: number, hi: number, n: number | null) =>
      (
        await this.#pool.query<Row>(
          `SELECT block, tx, idx, encode(address, 'hex') AS address, encode(block_hash, 'hex') AS block_hash, encode(tx_hash, 'hex') AS tx_hash,
                encode(keys, 'hex') AS keys, encode(data, 'hex') AS data FROM ${this.#schema}.events
         WHERE block BETWEEN $1 AND $2 AND address = ANY($3) AND selector = ANY($4) ORDER BY block, tx, idx LIMIT $5`,
          [lo, hi, a, s, n],
        )
      ).rows;
    const page = async (lo: number): Promise<{ rows: Row[]; through: number }> => {
      const rows = await query(lo, to, limit);
      if (rows.length < limit) return { rows, through: to };
      const last = rows.at(-1)!.block;
      if (rows[0]!.block === last) return { rows: await query(last, last, null), through: last };
      return { rows: rows.filter((r) => r.block < last), through: last - 1 };
    };
    let next = page(from);
    for (;;) {
      const { rows, through } = await next;
      if (through < to) next = page(through + 1);
      const events: EmittedEvent[] = rows.map((r) => ({
        from_address: feltFromMinimalBytes(r.address),
        keys: unpackHex(r.keys),
        data: unpackHex(r.data),
        block_number: r.block,
        block_hash: feltFromMinimalBytes(r.block_hash),
        transaction_hash: feltFromMinimalBytes(r.tx_hash),
        transaction_index: r.tx,
        event_index: r.idx,
      }));
      this.stats.cachedEvents += events.length;
      yield { events, through };
      if (through >= to) return;
    }
  }

  /** Remembers events fetched from RPC for `addresses` × `selectors` in `[from, to]`, until commits pass them. */
  track(addresses: string[], selectors: string[], from: number, to: number) {
    const pairs = { addresses: [...addresses], selectors: [...selectors] };
    this.#tracked.push({ pairs, from, to, events: [] });
  }

  /** Events of the range tracked last. */
  add(events: EmittedEvent[]) {
    const t = this.#tracked.at(-1);
    if (t === undefined) return;
    for (const e of events) t.events.push(e);
    this.stats.fetchedEvents += events.length;
  }

  /** A cached `starknet_call` result at a final block. */
  async getCall(
    address: string,
    entrypoint: string,
    calldata: string[],
    block: number,
  ): Promise<string[] | undefined> {
    const { rows } = await this.#pool.query<{ result: string }>(
      `SELECT encode(result, 'hex') AS result FROM ${this.#schema}.calls WHERE address = $1 AND entrypoint = $2 AND calldata = $3 AND block = $4`,
      [feltBytes(address), feltBytes(entrypoint), packFelts(calldata), block],
    );
    return rows[0] === undefined ? undefined : unpackHex(rows[0].result);
  }

  /** Keeps a call result until the next `persist`. */
  rememberCall(
    address: string,
    entrypoint: string,
    calldata: string[],
    block: number,
    result: string[],
  ) {
    this.#calls.push({
      address: feltBytes(address),
      entrypoint: feltBytes(entrypoint),
      calldata: packFelts(calldata),
      block,
      result: packFelts(result),
    });
  }

  /** Transaction and receipt JSON waiting for the next `persist`: the caller commits early past a limit. */
  get pendingBytes(): number {
    return this.#pendingBytes;
  }

  /** Cached transactions and receipts by hash (either may be missing). */
  async transactions(hashes: string[]): Promise<Map<string, RawExtras>> {
    const { rows } = await this.#pool.query<{
      hash: string;
      transaction: RawTransaction | null;
      receipt: RawReceipt | null;
    }>(
      `SELECT encode(hash, 'hex') AS hash, transaction, receipt FROM ${this.#schema}.transactions WHERE hash = ANY($1)`,
      [hashes.map(feltBytes)],
    );
    return new Map(
      rows.map((r) => [
        feltFromMinimalBytes(r.hash),
        {
          ...(r.transaction === null ? {} : { transaction: r.transaction }),
          ...(r.receipt === null ? {} : { receipt: r.receipt }),
        },
      ]),
    );
  }

  /** Keeps a fetched transaction and/or receipt until the next `persist`. */
  rememberTransaction(hash: string, block: number, x: RawExtras) {
    const transaction = x.transaction === undefined ? null : JSON.stringify(x.transaction);
    const receipt = x.receipt === undefined ? null : JSON.stringify(x.receipt);
    this.#pendingBytes += (transaction?.length ?? 0) + (receipt?.length ?? 0);
    this.#transactions.push({
      hash: feltBytes(hash),
      block,
      transaction,
      receipt,
    });
  }

  /**
   * Moves out what the next `persist` writes, before the commit's first await: transactions, receipts and calls
   * fetched so far, and the events of every tracked range the commit reaches, with its blocks through `through`
   * to mark covered (-1: none). What's fetched or tracked from here on is the next commit's.
   */
  take(through: number): void {
    const ranges: Tracked[] = [];
    for (const t of this.#tracked) {
      if (through < t.from) continue;
      const to = Math.min(through, t.to);
      ranges.push({ pairs: t.pairs, from: t.from, to, events: t.events });
      t.from = to + 1;
      t.events = [];
    }
    this.#tracked = this.#tracked.filter((t) => t.from <= t.to);
    this.#taken = { transactions: this.#transactions, calls: this.#calls, ranges };
    this.#transactions = [];
    this.#calls = [];
    this.#pendingBytes = 0;
  }

  /** Writes what `take` moved out, and marks its blocks covered, inside the caller's transaction. */
  async persist(tx: pg.PoolClient): Promise<void> {
    const taken = this.#taken;
    if (taken === undefined) throw new Error("persist without take");
    this.#taken = undefined;
    for (const t of chunks(taken.transactions, ROWS_PER_INSERT)) {
      await tx.query(
        `INSERT INTO ${this.#schema}.transactions SELECT * FROM unnest($1::bytea[], $2::int[], $3::jsonb[], $4::jsonb[])
         ON CONFLICT (hash) DO UPDATE SET transaction = coalesce(EXCLUDED.transaction, transactions.transaction), receipt = coalesce(EXCLUDED.receipt, transactions.receipt)`,
        [
          t.map((x) => x.hash),
          t.map((x) => x.block),
          t.map((x) => x.transaction),
          t.map((x) => x.receipt),
        ],
      );
    }
    if (taken.calls.length > 0) {
      const c = taken.calls;
      const r = await tx.query(
        `INSERT INTO ${this.#schema}.calls (address, entrypoint, calldata, block, result)
         SELECT * FROM unnest($1::bytea[], $2::bytea[], $3::bytea[], $4::int[], $5::bytea[]) ON CONFLICT DO NOTHING`,
        [
          c.map((x) => x.address),
          c.map((x) => x.entrypoint),
          c.map((x) => x.calldata),
          c.map((x) => x.block),
          c.map((x) => x.result),
        ],
      );
      this.#callRows += r.rowCount ?? 0;
      await this.#pruneCalls(tx);
    }
    if (taken.ranges.some((r) => r.events.length > 0)) {
      const events = function* () {
        for (const r of taken.ranges) yield* r.events;
      };
      if (!this.#overlaps) {
        // Straight into the table, a third cheaper than through a temp table, unless some are cached already.
        await tx.query(`SAVEPOINT kasbah_cache_events`);
        try {
          await copyLines(tx, `COPY ${this.#schema}.events FROM STDIN`, events(), eventLine);
          await tx.query(`RELEASE SAVEPOINT kasbah_cache_events`);
        } catch (e) {
          if ((e as { code?: string }).code !== UNIQUE_VIOLATION) throw e;
          await tx.query(`ROLLBACK TO SAVEPOINT kasbah_cache_events`);
          this.#overlaps = true;
        }
      }
      if (this.#overlaps) {
        await tx.query(
          `CREATE TEMP TABLE IF NOT EXISTS _kasbah_cache_in (LIKE ${this.#schema}.events) ON COMMIT DELETE ROWS`,
        );
        await copyLines(tx, `COPY _kasbah_cache_in FROM STDIN`, events(), eventLine);
        await tx.query(
          `INSERT INTO ${this.#schema}.events SELECT * FROM _kasbah_cache_in ON CONFLICT DO NOTHING`,
        );
      }
    }
    for (const { pairs, from, to } of taken.ranges) {
      const a: Buffer[] = [];
      const s: Buffer[] = [];
      for (const x of pairs.addresses)
        for (const y of pairs.selectors) {
          a.push(feltBytes(x));
          s.push(feltBytes(y));
        }
      await tx.query(
        `INSERT INTO ${this.#schema}.coverage (address, selector, ranges)
         SELECT address, selector, int8multirange(int8range($1, $2)) FROM unnest($3::bytea[], $4::bytea[]) AS p(address, selector)
         ON CONFLICT (address, selector) DO UPDATE SET ranges = coverage.ranges + EXCLUDED.ranges`,
        [from, to + 1, a, s],
      );
    }
  }

  /** Stops tracking (the rest of the range is live, or the run stopped). */
  untrack() {
    this.#tracked = [];
  }

  async headers(numbers: number[]): Promise<Map<number, Block>> {
    const { rows } = await this.#pool.query<{ header: BlockHeader }>(
      `SELECT header FROM ${this.#schema}.headers WHERE block = ANY($1) AND header IS NOT NULL`,
      [numbers],
    );
    return new Map(rows.map((r) => [r.header.block_number, blockOf(r.header)]));
  }

  async saveHeaders(headers: BlockHeader[]) {
    if (headers.length === 0) return;
    await this.#pool.query(
      `INSERT INTO ${this.#schema}.headers (block, hash, parent, timestamp, header)
       SELECT * FROM unnest($1::int[], $2::bytea[], $3::bytea[], $4::int8[], $5::jsonb[])
       ON CONFLICT (block) DO UPDATE SET header = EXCLUDED.header WHERE headers.header IS NULL`,
      [
        headers.map((h) => h.block_number),
        headers.map((h) => feltBytes(h.block_hash)),
        headers.map((h) => feltBytes(h.parent_hash)),
        headers.map((h) => h.timestamp),
        headers.map((h) => JSON.stringify(h)),
      ],
    );
  }
}
