import type pg from "pg";
import { transaction } from "../db/transaction.ts";
import { errorCode } from "../utils/errors.ts";
import { quote } from "../utils/quote.ts";
import { LOCK } from "./lock.ts";

/** Postgres's error codes for a missing table and a missing schema. */
const UNDEFINED_TABLE = "42P01";
const INVALID_SCHEMA = "3F000";

/** Another process (a prune, a reset) dropped the schema between the query that found it and the one reading it. */
const droppedSinceListed = (e: unknown) =>
  errorCode(e) === UNDEFINED_TABLE || errorCode(e) === INVALID_SCHEMA;

/** An app schema in a database, as `kasbah list` shows it and `kasbah prune` decides on it. */
export type SchemaInfo = {
  schema: string;
  /** A live indexer holds it: its lock has an owner and a heartbeat younger than `LOCK.timeoutMs`. */
  running: boolean;
  /** Made by `kasbah dev`; undefined for a schema from before the lock recorded it. */
  dev?: boolean;
  phase?: string;
  /** The last block committed. */
  block?: number;
  /** The last heartbeat, ms since the epoch; undefined when no indexer ever held the lock. */
  lastActive?: number;
  /** The app's tables, without kasbah's own (`_kasbah_*`). */
  tables: number;
  bytes: number;
};

/** An event cache schema (`kasbah_cache_<chain>`), shared by every app on the chain. */
export type CacheInfo = { schema: string; chain: string; bytes: number };

type LockRow = { owner: string | null; heartbeat: number; dev: boolean | null };

const live = (lock: LockRow | undefined, now: number) =>
  lock?.owner != null && lock.heartbeat + LOCK.timeoutMs > now;

/** Every schema holding `_kasbah_meta`, largest first, and the event caches, read from the catalog and the meta. */
export async function listSchemas(
  pool: pg.Pool,
  now = Date.now(),
): Promise<{ schemas: SchemaInfo[]; caches: CacheInfo[] }> {
  const { rows } = await pool.query<{
    schema: string;
    bytes: string;
    tables: string;
    app: boolean;
  }>(
    `SELECT n.nspname AS schema,
       coalesce(sum(pg_total_relation_size(c.oid)) FILTER (WHERE c.relkind IN ('r', 'p', 'm')), 0)::text AS bytes,
       count(*) FILTER (WHERE c.relkind IN ('r', 'p') AND c.relname NOT LIKE '\\_kasbah\\_%')::text AS tables,
       bool_or(c.relname = '_kasbah_meta' AND c.relkind = 'r') AS app
     FROM pg_namespace n LEFT JOIN pg_class c ON c.relnamespace = n.oid
     WHERE n.nspname LIKE 'kasbah\\_cache\\_%'
        OR EXISTS (SELECT 1 FROM pg_class m WHERE m.relnamespace = n.oid AND m.relname = '_kasbah_meta' AND m.relkind = 'r')
     GROUP BY 1`,
  );
  const schemas: SchemaInfo[] = [];
  const caches: CacheInfo[] = [];
  for (const r of rows) {
    if (r.app !== true) {
      caches.push({
        schema: r.schema,
        chain: chainName(r.schema.slice("kasbah_cache_".length)),
        bytes: Number(r.bytes),
      });
      continue;
    }
    let found: { key: string; value: unknown }[];
    try {
      found = (
        await pool.query<{ key: string; value: unknown }>(
          `SELECT key, value FROM ${quote(r.schema)}._kasbah_meta WHERE key IN ('lock', 'phase', 'checkpoint')`,
        )
      ).rows;
    } catch (e) {
      if (droppedSinceListed(e)) continue;
      throw e;
    }
    const meta = new Map(found.map((m) => [m.key, m.value]));
    const lock = meta.get("lock") as LockRow | undefined;
    const checkpoint = meta.get("checkpoint");
    const phase = meta.get("phase");
    schemas.push({
      schema: r.schema,
      running: live(lock, now),
      dev: lock?.dev ?? undefined,
      phase: typeof phase === "string" ? phase : undefined,
      block: typeof checkpoint === "number" ? checkpoint : undefined,
      lastActive: lock === undefined || lock.heartbeat === 0 ? undefined : lock.heartbeat,
      tables: Number(r.tables),
      bytes: Number(r.bytes),
    });
  }
  const bySize = (a: { bytes: number }, b: { bytes: number }) => b.bytes - a.bytes;
  return { schemas: schemas.sort(bySize), caches: caches.sort(bySize) };
}

/**
 * Drops each of `schemas` no live indexer holds, checked under its lock row (`FOR UPDATE`) in the transaction that
 * drops it, so an indexer starting meanwhile either waits and recreates it, or keeps it. Returns those dropped.
 */
export async function dropStopped(pool: pg.Pool, schemas: readonly string[]): Promise<string[]> {
  const dropped: string[] = [];
  for (const schema of schemas) {
    const gone = await transaction(pool, async (tx) => {
      const table = `${quote(schema)}._kasbah_meta`;
      if ((await tx.query(`SELECT to_regclass($1) AS r`, [table])).rows[0].r === null) return false;
      const lock = (
        await tx.query<{ value: LockRow }>(
          `SELECT value FROM ${table} WHERE key = 'lock' FOR UPDATE`,
        )
      ).rows[0]?.value;
      if (live(lock, Date.now())) return false;
      await tx.query(`DROP SCHEMA ${quote(schema)} CASCADE`);
      return true;
    });
    if (gone) dropped.push(schema);
  }
  return dropped;
}

/** A chain id as its name when it is one (`0x534e5f4d41494e` is `SN_MAIN`), else as given. */
export function chainName(id: string): string {
  if (!/^0x([0-9a-f]{2})+$/i.test(id)) return id;
  const text = Buffer.from(id.slice(2), "hex").toString("latin1");
  return /^[A-Za-z0-9_]{2,}$/.test(text) ? text : id;
}
