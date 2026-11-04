import type pg from "pg";
import { DEFAULTS } from "../config/resolve.ts";
import type { BlockHeader, EmittedEvent } from "../rpc/methods.ts";
import type { RawExtras } from "../sync/extras.ts";
import type { Batch, PageStore } from "../sync/fetch.ts";
import { type Block, blockOf } from "../types/block.ts";
import { canonical } from "../types/felt.ts";
import type { RawReceipt, RawTransaction } from "../types/transaction.ts";
import { chunks } from "../utils/chunks.ts";
import { heapLimit } from "../utils/memory.ts";
import { YIELD_MS, yieldToEventLoop } from "../utils/time.ts";
import { copyLines } from "./copy.ts";
import { quote } from "./table.ts";
import { transaction } from "./transaction.ts";

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
/**
 * Share of the heap for fetched events waiting for Postgres, the write in flight included: past it, fetching waits.
 * It's the fetch thread's heap, a quarter of the indexer's (`FETCH_HEAP_SHARE`): a twentieth of that. Writes keep up
 * on any disk that keeps up with the RPC, so it's reached only on a slow one.
 */
const WRITE_SHARE = 1 / 5;
const MIN_WRITE_BYTES = 8 << 20;
/** Most events per batch read back for the handlers. */
const READ_LIMIT = 12_000;
/**
 * Share of the heap one read-back batch may take, decoded: about four are alive at once (the next one's rows, the one
 * being decoded, the one prepared, the one handled), each with the rows its handlers write. Large events fill it
 * before `READ_LIMIT` does: 30-felt events ran a 256 MB heap out of memory at 12k per batch.
 */
const READ_SHARE = 1 / 64;
/**
 * Events in the cache's first read-back batch, before their size is known. Only the first: a backfill reads from
 * where it is to the fetch thread's front each time that moves, several times a second, and every such read starting
 * at 1,000 cost Ekubo 7–9 s to block 652k (4%, 2 runs each, 2026-11-03).
 */
const READ_FIRST_EVENTS = 1_000;
/**
 * Blocks the first read-back query spans; each next one spans what held about `READ_LIMIT` events. A query over all
 * that is written ran 7.7 s instead of milliseconds while the fetch thread was 600k blocks ahead (Ekubo, 2026-11-03):
 * Postgres took a plan that collects the whole range before it sorts. Bounded, no plan touches far more than a batch.
 */
const READ_FIRST_BLOCKS = 1_000;
/** The most a read's span grows from one query to the next, so a dense stretch after a sparse one costs one big query at most. */
const READ_GROWTH = 4;
/** Span of `recentReads`. */
const READ_WINDOW_MS = 5_000;
/** Share of `maxCalls` left after pruning, so the next inserts don't prune again at once. */
const CALLS_KEPT = 0.9;

const SCHEMA_SQL = (s: string) => [
  `CREATE SCHEMA IF NOT EXISTS ${s}`,
  `CREATE TABLE IF NOT EXISTS ${s}.events (block integer NOT NULL, tx integer NOT NULL, idx integer NOT NULL, address bytea NOT NULL,
     selector bytea NOT NULL, block_hash bytea NOT NULL, tx_hash bytea NOT NULL, keys bytea NOT NULL, data bytea NOT NULL, PRIMARY KEY (block, tx, idx))`,
  `CREATE TABLE IF NOT EXISTS ${s}.coverage (address bytea NOT NULL, selector bytea NOT NULL, filter bytea NOT NULL DEFAULT '',
     ranges int8multirange NOT NULL, CONSTRAINT coverage_by_filter PRIMARY KEY (address, selector, filter))`,
  // Caches from before key filters: coverage gains its filter, empty for what was there. Locked, as several indexers
  // may open the same cache at once.
  `DO $$ BEGIN
     PERFORM pg_advisory_xact_lock(hashtext('${s}.coverage'));
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coverage_by_filter' AND conrelid = '${s}.coverage'::regclass) THEN
       ALTER TABLE ${s}.coverage ADD COLUMN IF NOT EXISTS filter bytea NOT NULL DEFAULT '';
       ALTER TABLE ${s}.coverage DROP CONSTRAINT IF EXISTS coverage_pkey;
       ALTER TABLE ${s}.coverage ADD CONSTRAINT coverage_by_filter PRIMARY KEY (address, selector, filter);
     END IF;
   END $$`,
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

/**
 * `approxBytes` of a fetched event, without its walk over every property: summing every page's events that way took
 * ~8% of the main thread while it was busiest (Ekubo, 2026-11-03). Object and fields 88, three numbers 24, two
 * arrays 48, then each string twice its length and each felt in an array 8 more.
 */
function eventBytes(e: EmittedEvent): number {
  let n = 160 + 2 * (e.from_address.length + e.transaction_hash.length);
  n += e.block_hash === undefined ? 8 : 2 * e.block_hash.length;
  for (const k of e.keys) n += 2 * k.length + 8;
  for (const d of e.data) n += 2 * d.length + 8;
  return n;
}

/**
 * What a row read back takes once decoded, from its hex text's lengths alone: `eventBytes` walks every felt, and on
 * the main thread, as busy as it is during a backfill, that walk costs what it cost the writer. A packed felt's hex
 * is about as long as its decoded text, its length byte standing for the `0x`; the third more per character covers
 * each felt's 8 bytes in its array (more than enough for a full felt, about right for a small one).
 */
function rowBytes(r: {
  address: string;
  block_hash: string;
  tx_hash: string;
  keys: string;
  data: string;
}) {
  return (
    166 +
    2 * (r.address.length + r.block_hash.length + r.tx_hash.length) +
    3 * (r.keys.length + r.data.length)
  );
}

/** Postgres' code for a duplicate key. */
const UNIQUE_VIOLATION = "23505";

/** Addresses × selectors, and the key filter after the selector as `filterBytes` encodes it (empty for none). */
type Pairs = { addresses: string[]; selectors: string[]; filter: Buffer };

/**
 * A key filter's identity in coverage: each position's values, canonical, deduplicated and sorted, with trailing
 * wildcards dropped. Empty for none, so a filter of only wildcards is the unfiltered stream.
 */
export function filterBytes(filter: readonly (readonly string[])[]): Buffer {
  const positions = filter.map((p) => [...new Set(p.map(canonical))].sort());
  while (positions.length > 0 && positions.at(-1)!.length === 0) positions.pop();
  return positions.length === 0 ? Buffer.alloc(0) : Buffer.from(JSON.stringify(positions));
}

/** Coverage that counts for `filter`: the unfiltered stream's, and the filter's own. */
const countsFor = (filter: Buffer): Buffer[] =>
  filter.length === 0 ? [filter] : [Buffer.alloc(0), filter];

/** Whether an event's keys after the selector pass `filter` (`getEvents` semantics: each position one of, or any). */
function keysPass(sets: Set<string>[], keys: readonly string[]): boolean {
  for (let i = 0; i < sets.length; i++) {
    const set = sets[i]!;
    if (set.size === 0) continue;
    const k = keys[i + 1];
    if (k === undefined || !set.has(canonical(k))) return false;
  }
  return true;
}
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
/** One commit's share: the transactions, receipts and calls fetched until it started. */
type Taken = { transactions: CachedTransaction[]; calls: CachedCall[] };
/** Every event of `pairs` in blocks `[from, to]`, fetched and waiting for Postgres. */
type Write = {
  pairs: Pairs;
  events: EmittedEvent[];
  from: number;
  to: number;
  bytes: number;
  written: () => void;
  failed: (error: unknown) => void;
};

/**
 * Final events (below the reorg window) kept in Postgres, shared by every app on the same database and chain.
 * `coverage` says which blocks are complete for each (address, selector at key 0). A backfill writes what it fetches
 * here as it arrives (`writer`) and its handlers read events back from here; a re-index fetches only the blocks not
 * covered.
 */
export class EventCache {
  readonly #pool: pg.Pool;
  readonly #schema: string;
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
  #committedCallRows = 0;
  /** Fetched pages waiting for the next write, oldest first. */
  #writes: Write[] = [];
  #held = { bytes: 0, events: 0 };
  readonly #maxHeld = Math.max(MIN_WRITE_BYTES, Math.floor(heapLimit() * WRITE_SHARE));
  /** The writes under way; it never rejects (each page's promise does). */
  #writing: Promise<void> | undefined;
  #roomWakers: (() => void)[] = [];
  #reads = { at: performance.now(), count: 0, slowestMs: 0 };
  #readsShown = { count: 0, slowestMs: 0 };
  /** Decoded bytes per event in the last batch read back, which sizes the next read's batches. */
  #eventSize: number | undefined;

  readonly chainId: string;

  private constructor(pool: pg.Pool, chainId: string, maxCalls: number) {
    this.chainId = chainId;
    this.#pool = pool;
    this.#schema = quote(`kasbah_cache_${chainId.toLowerCase()}`);
    this.#maxCalls = maxCalls;
  }

  /** `maxCalls`: call results kept; past it the oldest are dropped down to 90%. Default 1M. */
  static async open(
    pool: pg.Pool,
    chainId: string,
    o: { maxCalls?: number } = {},
  ): Promise<EventCache> {
    const cache = new EventCache(pool, chainId, o.maxCalls ?? DEFAULTS.maxCalls);
    for (const sql of SCHEMA_SQL(cache.#schema)) await pool.query(sql);
    const counted = Number(
      (await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${cache.#schema}.calls`)).rows[0]!
        .n,
    );
    await transaction(pool, async (tx) => {
      cache.#callRows = counted;
      await cache.#pruneCalls(tx);
    });
    cache.#committedCallRows = cache.#callRows;
    return cache;
  }

  /** The cache `open` made, for its writer in another thread: nothing created, counted or pruned. */
  static attach(pool: pg.Pool, chainId: string): EventCache {
    return new EventCache(pool, chainId, DEFAULTS.maxCalls);
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
  async coveredUntil(
    addresses: string[],
    selectors: string[],
    from: number,
    filter: string[][] = [],
  ): Promise<number> {
    if (addresses.length === 0 || selectors.length === 0) return from;
    const { a, s } = this.#pairs({ addresses, selectors, filter: filterBytes(filter) });
    const { rows } = await this.#pool.query<{ end: string }>(
      `SELECT min(coalesce(x.up, $1::int8))::text AS end FROM unnest($2::bytea[], $3::bytea[]) AS p(address, selector)
       LEFT JOIN LATERAL (SELECT upper(r) AS up FROM unnest((SELECT range_agg(c.ranges) FROM ${this.#schema}.coverage c
                            WHERE c.address = p.address AND c.selector = p.selector AND c.filter = ANY($4::bytea[]))) r
                          WHERE r @> $1::int8) x ON true`,
      [from, a, s, countsFor(filterBytes(filter))],
    );
    return Number(rows[0]!.end);
  }

  /** The parts of `[from, to]` not covered for every (address, selector) pair, inclusive, in order. */
  async missing(
    addresses: string[],
    selectors: string[],
    from: number,
    to: number,
    filter: string[][] = [],
  ): Promise<[number, number][]> {
    const { a, s } = this.#pairs({ addresses, selectors, filter: filterBytes(filter) });
    const { rows } = await this.#pool.query<{ lo: string; hi: string }>(
      `SELECT lower(m)::text AS lo, (upper(m) - 1)::text AS hi FROM unnest(int8multirange(int8range($1, $2)) - (
         SELECT CASE WHEN count(x.ranges) = count(*) THEN coalesce(range_intersect_agg(x.ranges), '{}') ELSE '{}' END
         FROM unnest($3::bytea[], $4::bytea[]) AS p(address, selector)
         LEFT JOIN LATERAL (SELECT range_agg(c.ranges) AS ranges FROM ${this.#schema}.coverage c
           WHERE c.address = p.address AND c.selector = p.selector AND c.filter = ANY($5::bytea[])) x ON true)) AS m ORDER BY 1`,
      [from, to + 1, a, s, countsFor(filterBytes(filter))],
    );
    return rows.map((r) => [Number(r.lo), Number(r.hi)]);
  }

  #pairs(pairs: Pairs): { a: Buffer[]; s: Buffer[] } {
    const a: Buffer[] = [];
    const s: Buffer[] = [];
    for (const x of pairs.addresses)
      for (const y of pairs.selectors) {
        a.push(feltBytes(x));
        s.push(feltBytes(y));
      }
    return { a, s };
  }

  /**
   * Cached events of `addresses` × `selectors` in `[from, to]`, in chain order, at most about `limit` per batch
   * and fewer when large events pass `READ_SHARE` of the heap: paged by position, and a batch never ends inside a block. `cached`: counted as read from the cache, not
   * fetched by this run. `filter`: the keys after the selector, as `getEvents` takes them; a range the unfiltered
   * stream covers holds the events it drops too.
   */
  async *read(
    addresses: string[],
    selectors: string[],
    from: number,
    to: number,
    limit = READ_LIMIT,
    cached = true,
    filter: string[][] = [],
  ): AsyncGenerator<Batch> {
    const a = addresses.map(feltBytes);
    const s = selectors.map(feltBytes);
    const sets =
      filterBytes(filter).length === 0 ? [] : filter.map((p) => new Set(p.map(canonical)));
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
    let span = READ_FIRST_BLOCKS;
    const budget = heapLimit() * READ_SHARE;
    const sized = (perEvent: number) => Math.max(1, Math.min(limit, Math.floor(budget / perEvent)));
    let most =
      this.#eventSize === undefined ? Math.min(limit, READ_FIRST_EVENTS) : sized(this.#eventSize);
    const page = async (lo: number): Promise<{ rows: Row[]; through: number }> => {
      const hi = Math.min(to, lo + span - 1);
      const n = most;
      const rows = await this.#timed(query(lo, hi, n));
      if (rows.length < n) {
        span = Math.ceil(span * Math.min(READ_GROWTH, n / Math.max(1, rows.length)));
        return { rows, through: hi };
      }
      const last = rows.at(-1)!.block;
      // From the density at the batch's end, where the next one starts: its start may lie in a sparse stretch.
      span = Math.max(1, 2 * (last - rows[rows.length >> 1]!.block));
      if (rows[0]!.block === last)
        return { rows: await this.#timed(query(last, last, null)), through: last };
      return { rows: rows.filter((r) => r.block < last), through: last - 1 };
    };
    let next = page(from);
    for (;;) {
      const { rows, through } = await next;
      if (through < to) next = page(through + 1);
      // A batch took up to ~170 ms to decode (Ekubo): a turn for the event loop meanwhile, as handlers give one.
      const events: EmittedEvent[] = [];
      let bytes = 0;
      let since = performance.now();
      for (const r of rows) {
        const keys = unpackHex(r.keys);
        if (sets.length > 0 && !keysPass(sets, keys)) continue;
        events.push({
          from_address: feltFromMinimalBytes(r.address),
          keys,
          data: unpackHex(r.data),
          block_number: r.block,
          block_hash: feltFromMinimalBytes(r.block_hash),
          transaction_hash: feltFromMinimalBytes(r.tx_hash),
          transaction_index: r.tx,
          event_index: r.idx,
        });
        bytes += rowBytes(r);
        if (performance.now() - since > YIELD_MS) {
          await yieldToEventLoop();
          since = performance.now();
        }
      }
      if (events.length > 0) {
        this.#eventSize = bytes / events.length;
        most = sized(this.#eventSize);
      }
      if (cached) this.stats.cachedEvents += events.length;
      yield { events, through };
      if (through >= to) return;
    }
  }

  async #timed<T>(query: Promise<T>): Promise<T> {
    const started = performance.now();
    const result = await query;
    const ms = performance.now() - started;
    this.#rollReads();
    this.#reads.count++;
    this.#reads.slowestMs = Math.max(this.#reads.slowestMs, ms);
    return result;
  }

  #rollReads() {
    const now = performance.now();
    if (now - this.#reads.at < READ_WINDOW_MS) return;
    this.#readsShown = { count: this.#reads.count, slowestMs: this.#reads.slowestMs };
    this.#reads = { at: now, count: 0, slowestMs: 0 };
  }

  /** Read-back queries in the last few seconds, and the slowest's milliseconds: `--debug` shows them. */
  recentReads(): { count: number; slowestMs: number } {
    this.#rollReads();
    return this.#readsShown;
  }

  /**
   * Where a fetch of `addresses` × `selectors` writes its pages: each page's events and its blocks' coverage in one
   * transaction, so coverage never claims a block whose events aren't written. Pages are written in the order
   * they're given, together while the write before them runs, so a write grows with the backlog.
   */
  writer(addresses: string[], selectors: string[], filter: string[][] = []): PageStore {
    const pairs = {
      addresses: [...addresses],
      selectors: [...selectors],
      filter: filterBytes(filter),
    };
    return {
      write: (events, from, to) =>
        new Promise<void>((written, failed) => {
          let bytes = 0;
          for (const e of events) bytes += eventBytes(e);
          this.#writes.push({ pairs, events, from, to, bytes, written, failed });
          this.#held.bytes += bytes;
          this.#held.events += events.length;
          this.stats.fetchedEvents += events.length;
          this.#writing ??= this.#flush();
        }),
      room: () =>
        this.#held.bytes < this.#maxHeld
          ? Promise.resolve()
          : new Promise<void>((r) => this.#roomWakers.push(r)),
      held: () => ({ ...this.#held, max: this.#maxHeld }),
    };
  }

  /** Waits for every page given to a writer to be written (or to fail). */
  async drain(): Promise<void> {
    while (this.#writing !== undefined) await this.#writing;
  }

  async #flush(): Promise<void> {
    for (;;) {
      // Cleared in the same turn the last page settles, so a page given after it starts a write of its own.
      if (this.#writes.length === 0) {
        this.#writing = undefined;
        return;
      }
      const batch = this.#writes;
      this.#writes = [];
      try {
        await transaction(this.#pool, async (tx) => {
          await this.#copyEvents(tx, function* () {
            for (const w of batch) yield* w.events;
          });
          await this.#cover(tx, batch);
        });
        for (const w of batch) w.written();
      } catch (error) {
        for (const w of batch) w.failed(error);
      } finally {
        for (const w of batch) {
          this.#held.bytes -= w.bytes;
          this.#held.events -= w.events.length;
        }
        if (this.#held.bytes < this.#maxHeld) {
          const wake = this.#roomWakers;
          this.#roomWakers = [];
          for (const r of wake) r();
        }
      }
    }
  }

  async #copyEvents(tx: pg.PoolClient, events: () => Iterable<EmittedEvent>) {
    if (!this.#overlaps) {
      // Straight into the table, a third cheaper than through a temp table, unless some are cached already.
      await tx.query(`SAVEPOINT kasbah_cache_events`);
      try {
        await copyLines(tx, `COPY ${this.#schema}.events FROM STDIN`, events(), eventLine);
        await tx.query(`RELEASE SAVEPOINT kasbah_cache_events`);
        return;
      } catch (e) {
        if ((e as { code?: string }).code !== UNIQUE_VIOLATION) throw e;
        await tx.query(`ROLLBACK TO SAVEPOINT kasbah_cache_events`);
        this.#overlaps = true;
      }
    }
    await tx.query(
      `CREATE TEMP TABLE IF NOT EXISTS _kasbah_cache_in (LIKE ${this.#schema}.events) ON COMMIT DELETE ROWS`,
    );
    await copyLines(tx, `COPY _kasbah_cache_in FROM STDIN`, events(), eventLine);
    await tx.query(
      `INSERT INTO ${this.#schema}.events SELECT * FROM _kasbah_cache_in ON CONFLICT DO NOTHING`,
    );
  }

  /** Marks each write's blocks covered for its pairs: one statement per set of pairs. */
  async #cover(tx: pg.PoolClient, writes: Write[]) {
    const byPairs = new Map<Pairs, { lo: number[]; hi: number[] }>();
    for (const w of writes) {
      let r = byPairs.get(w.pairs);
      if (r === undefined) byPairs.set(w.pairs, (r = { lo: [], hi: [] }));
      r.lo.push(w.from);
      r.hi.push(w.to + 1);
    }
    for (const [pairs, { lo, hi }] of byPairs) {
      const { a, s } = this.#pairs(pairs);
      await tx.query(
        `INSERT INTO ${this.#schema}.coverage (address, selector, filter, ranges)
         SELECT address, selector, $5, (SELECT range_agg(int8range(lo, hi)) FROM unnest($3::int8[], $4::int8[]) AS r(lo, hi))
         FROM unnest($1::bytea[], $2::bytea[]) AS p(address, selector)
         ON CONFLICT (address, selector, filter) DO UPDATE SET ranges = coverage.ranges + EXCLUDED.ranges`,
        [a, s, lo, hi, pairs.filter],
      );
    }
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
   * fetched so far. What's fetched from here on is the next commit's.
   */
  take(): void {
    this.#taken = { transactions: this.#transactions, calls: this.#calls };
    this.#transactions = [];
    this.#calls = [];
    this.#pendingBytes = 0;
  }

  /** Writes what `take` moved out, inside the caller's transaction: again if that transaction is retried. */
  async persist(tx: pg.PoolClient): Promise<void> {
    const taken = this.#taken;
    if (taken === undefined) throw new Error("persist without take");
    this.#callRows = this.#committedCallRows;
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
  }

  /** After the commit's transaction committed: what `take` moved out is let go, and its calls are counted. */
  written(): void {
    this.#taken = undefined;
    this.#committedCallRows = this.#callRows;
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
