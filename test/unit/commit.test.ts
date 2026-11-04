import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { Store } from "../../src/db/store.ts";
import { Position } from "../../src/indexer/commit.ts";
import { SchemaLock } from "../../src/indexer/lock.ts";
import type { Sources } from "../../src/indexer/sources.ts";
import { Status } from "../../src/indexer/status.ts";

const url = process.env.DATABASE_URL;
const schema = "kasbah_test_commit";
let pool: pg.Pool;

beforeAll(async () => {
  if (url === undefined) return;
  pool = new pg.Pool({ connectionString: url, max: 4, options: `-c search_path=${schema}` });
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
});

afterAll(async () => {
  if (url === undefined) return;
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.end();
});

test.skipIf(url === undefined)(
  "a commit started in the background: the next start waits for it, and a failed one is thrown by every call after",
  async () => {
    const status = new Status();
    const lock = await SchemaLock.acquire(
      pool,
      schema,
      { dev: false, reset: false, buildId: "test" },
      status,
      new AbortController().signal,
    );
    status.enter("backfill");
    status.setRange(0, 100, -1);
    const position = new Position(
      {
        pool,
        store: new Store(drizzle(pool), [], { complete: true }),
        cache: undefined,
        factories: [],
        // Read only by children and revert commits.
        sources: {} as Sources,
        status,
        lock,
        final: () => 0,
        start: 0,
      },
      { checkpoint: undefined, watermark: 0, known: new Map() },
    );
    const stored = async () =>
      (await pool.query(`SELECT value FROM _kasbah_meta WHERE key = 'checkpoint'`)).rows[0]?.value;

    await position.start({ kind: "batch", through: 10 });
    await position.start({ kind: "batch", through: 20 });
    expect(position.checkpoint).toBe(10);
    await position.drain();
    expect([position.checkpoint, await stored()]).toEqual([20, 20]);
    expect(status.time.commit).toBeGreaterThan(0);

    await pool.query(
      `UPDATE _kasbah_meta SET value = jsonb_set(value, '{owner}', '"other"') WHERE key = 'lock'`,
    );
    await position.start({ kind: "batch", through: 30 });
    await expect(position.drain()).rejects.toThrow(`lost the lock on schema "${schema}"`);
    expect(() => position.check()).toThrow("lost the lock");
    await expect(position.start({ kind: "batch", through: 40 })).rejects.toThrow("lost the lock");
    await expect(position.commit({ kind: "batch", through: 40 })).rejects.toThrow("lost the lock");
    expect([position.checkpoint, await stored()]).toEqual([20, 20]);
    await lock.release();
  },
);
