import { randomUUID } from "node:crypto";
import type pg from "pg";
import { ConfigError } from "../config/errors.ts";
import { quote } from "../db/table.ts";
import { transaction } from "../db/transaction.ts";
import { Stopped } from "../utils/errors.ts";
import { sleep } from "../utils/sleep.ts";
import type { Status } from "./status.ts";

/**
 * The schema lock: a heartbeat in `_kasbah_meta`, refreshed every `intervalMs`; a lock without one for `timeoutMs`
 * belongs to a process that died. Tests shorten them.
 */
export const LOCK = { intervalMs: 10_000, timeoutMs: 25_000 };

/** `dev`: which command made the schema; `null` for a schema from before the lock. */
type LockRow = { owner: string | null; heartbeat: number; dev: boolean | null };

/** `dev`: `onBuildChange: "reset"`, what `kasbah dev` runs with; a changed build drops the schema. */
type Claim = { dev: boolean; reset: boolean; buildId: string };

type Attempt = { claimed: true } | { claimed: false; untilMs: number };

const META = `CREATE TABLE IF NOT EXISTS _kasbah_meta (key text PRIMARY KEY, value jsonb NOT NULL)`;

/**
 * Holds the app's schema for one indexer. Claimed in one transaction with the build rules, so dropping the schema
 * never races another process: `dev` never touches a schema `start` made, and `start` drops one `dev` made.
 */
export class SchemaLock {
  readonly owner = randomUUID();
  readonly #pool: pg.Pool;
  readonly #schema: string;
  #timer: NodeJS.Timeout | undefined;

  private constructor(pool: pg.Pool, schema: string) {
    this.#pool = pool;
    this.#schema = schema;
  }

  /**
   * Claims the schema (`pool` is on it), creating it if needed and dropping it when `claim` says so. Held by a live
   * indexer: waits once for its heartbeat to expire, then refuses.
   */
  static async acquire(
    pool: pg.Pool,
    schema: string,
    claim: Claim,
    status: Status,
    signal: AbortSignal,
  ): Promise<SchemaLock> {
    const lock = new SchemaLock(pool, schema);
    const first = await lock.#try(claim, status);
    if (!first.claimed) {
      status.note({
        kind: "locked",
        schema,
        seconds: Math.ceil((first.untilMs - Date.now()) / 1000),
      });
      await sleep(Math.max(0, first.untilMs - Date.now()), signal);
      if (signal.aborted) throw new Stopped();
      if (!(await lock.#try(claim, status)).claimed)
        throw new ConfigError(
          `schema "${schema}" is in use by another indexer: stop it, or use another --schema (DATABASE_SCHEMA)`,
        );
    }
    lock.#timer = setInterval(() => void lock.#beat().catch(() => {}), LOCK.intervalMs);
    lock.#timer.unref();
    return lock;
  }

  async #try(claim: Claim, status: Status): Promise<Attempt> {
    const s = quote(this.#schema);
    return transaction(this.#pool, async (tx) => {
      await tx.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
      await tx.query(META);
      await tx.query(
        `INSERT INTO _kasbah_meta VALUES ('lock', '{"owner": null, "heartbeat": 0, "dev": null}') ON CONFLICT (key) DO NOTHING`,
      );
      const row = (
        await tx.query<{ value: LockRow }>(
          `SELECT value FROM _kasbah_meta WHERE key = 'lock' FOR UPDATE`,
        )
      ).rows[0]?.value;
      // Gone: another process dropped the schema while this one waited for the row.
      if (row === undefined) return { claimed: false, untilMs: Date.now() };
      const expiry = row.heartbeat + LOCK.timeoutMs;
      if (row.owner !== null && expiry > Date.now()) return { claimed: false, untilMs: expiry };
      const build = (
        await tx.query<{ value: string }>(`SELECT value FROM _kasbah_meta WHERE key = 'build'`)
      ).rows[0]?.value;
      if (build !== undefined && claim.dev && row.dev === false)
        throw new ConfigError(
          `schema "${this.#schema}" holds what kasbah start indexed, and dev would drop it: use another --schema, or drop it with kasbah clean`,
        );
      const fromDev = build !== undefined && !claim.dev && row.dev === true;
      const rebuilt = build !== undefined && claim.dev && build !== claim.buildId;
      if (fromDev) status.note({ kind: "rebuild", reason: "dev" });
      else if (rebuilt) status.note({ kind: "rebuild", reason: "build" });
      if (claim.reset || fromDev || rebuilt) {
        await tx.query(`DROP SCHEMA ${s} CASCADE`);
        await tx.query(`CREATE SCHEMA ${s}`);
        await tx.query(META);
      }
      await tx.query(
        `INSERT INTO _kasbah_meta VALUES ('lock', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [{ owner: this.owner, heartbeat: Date.now(), dev: claim.dev } satisfies LockRow],
      );
      return { claimed: true };
    });
  }

  /** A beat retried through an outage may land after a newer one: the heartbeat only moves forward. */
  async #beat(): Promise<void> {
    await this.#pool.query(
      `UPDATE _kasbah_meta SET value = jsonb_set(value, '{heartbeat}', to_jsonb(GREATEST((value->>'heartbeat')::bigint, $1::bigint)))
       WHERE key = 'lock' AND value->>'owner' = $2`,
      [Date.now(), this.owner],
    );
  }

  /**
   * In each commit's transaction: refuses to write once another indexer took the schema over (this one lost the
   * database for longer than the timeout). `FOR SHARE` makes a takeover wait for this commit.
   */
  async check(tx: pg.PoolClient): Promise<void> {
    const { rowCount } = await tx.query(
      `SELECT 1 FROM _kasbah_meta WHERE key = 'lock' AND value->>'owner' = $1 FOR SHARE`,
      [this.owner],
    );
    if (rowCount === 0)
      throw new ConfigError(
        `lost the lock on schema "${this.#schema}": another indexer took it over after ${LOCK.timeoutMs / 1000} s without a heartbeat`,
      );
  }

  /** On a clean stop, so the next indexer starts at once. */
  async release(): Promise<void> {
    clearInterval(this.#timer);
    await this.#pool.query(
      `UPDATE _kasbah_meta SET value = jsonb_set(value, '{owner}', 'null') WHERE key = 'lock' AND value->>'owner' = $1`,
      [this.owner],
    );
  }
}

/** Whether a live indexer holds `schema` (`pool` may be on any schema). */
export async function inUse(pool: pg.Pool, schema: string): Promise<boolean> {
  const table = `${quote(schema)}._kasbah_meta`;
  if ((await pool.query(`SELECT to_regclass($1) AS r`, [table])).rows[0].r === null) return false;
  const row = (
    await pool.query<{ value: LockRow }>(`SELECT value FROM ${table} WHERE key = 'lock'`)
  ).rows[0]?.value;
  return row?.owner != null && row.heartbeat + LOCK.timeoutMs > Date.now();
}
