import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { RetryingPool } from "../../src/db/pool.ts";
import { lostConnection, retrying } from "../../src/db/retry.ts";
import { transaction } from "../../src/db/transaction.ts";
import { Stopped } from "../../src/utils/errors.ts";
import { pgProxy } from "../fixtures/pgproxy.ts";

const url = process.env.DATABASE_URL;
const schema = "kasbah_test_retry";
const lost = () => new Error("Connection terminated unexpectedly");

test("a lost connection is told apart from other errors", () => {
  for (const code of ["57P01", "08006", "53300", "ECONNREFUSED", "ECONNRESET"])
    expect(lostConnection(Object.assign(new Error("x"), { code }))).toBe(true);
  expect(lostConnection(lost())).toBe(true);
  expect(
    lostConnection(new Error("Client has encountered a connection error and is not queryable")),
  ).toBe(true);
  expect(lostConnection(new Error("query failed", { cause: lost() }))).toBe(true);
  expect(lostConnection(Object.assign(new Error("duplicate key"), { code: "23505" }))).toBe(false);
  expect(lostConnection(new Error('syntax error at or near "SELEC"'))).toBe(false);
});

test("retries wait about 125 ms and twice as long each time (half to all of it, at random), then the last try's error is thrown", async () => {
  vi.useFakeTimers();
  try {
    const waits: number[] = [];
    let tries = 0;
    const done = retrying(
      async () => {
        tries++;
        throw lost();
      },
      { tries: 4, onRetry: (_, __, ms) => waits.push(ms) },
    ).catch((e: Error) => e);
    await vi.runAllTimersAsync();
    expect((await done) as Error).toMatchObject({ message: "Connection terminated unexpectedly" });
    expect(tries).toBe(4);
    expect(waits.map((ms, i) => ms >= 62.5 * 2 ** i && ms <= 125 * 2 ** i)).toEqual([
      true,
      true,
      true,
    ]);
  } finally {
    vi.useRealTimers();
  }
});

test("any other error is thrown at once, and a success after retries is announced", async () => {
  let calls = 0;
  await expect(
    retrying(async () => {
      calls++;
      throw new Error("relation does not exist");
    }),
  ).rejects.toThrow("relation does not exist");
  expect(calls).toBe(1);

  const back: number[] = [];
  const out = await retrying(
    async (attempt) => {
      if (attempt < 2) throw lost();
      return "ok";
    },
    { firstWaitMs: 1, onBack: (n) => back.push(n) },
  );
  expect([out, back]).toEqual(["ok", [2]]);
});

test("a stop during the wait ends the retries", async () => {
  const stop = new AbortController();
  const done = retrying(
    async () => {
      throw lost();
    },
    { firstWaitMs: 60_000, signal: stop.signal },
  );
  stop.abort();
  await expect(done).rejects.toBeInstanceOf(Stopped);
});

describe.skipIf(url === undefined)("through a proxy that loses connections", () => {
  let proxy: Awaited<ReturnType<typeof pgProxy>>;
  let pool: RetryingPool;
  const direct = () => new RetryingPool({ connectionString: url, max: 1 });

  beforeAll(async () => {
    proxy = await pgProxy(url!);
    pool = new RetryingPool({ connectionString: proxy.url, max: 2 }, { firstWaitMs: 20 });
    const d = direct();
    await d.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await d.query(`CREATE SCHEMA ${schema}`);
    await d.end();
  });
  afterAll(async () => {
    await pool.end();
    await proxy.close();
    const d = direct();
    await d.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await d.end();
  });

  /** A table with no key, so a transaction that ran twice shows as twice the rows. */
  async function fresh(name: string) {
    await pool.query(`CREATE TABLE ${schema}.${name} (x int)`);
    return async () =>
      Number((await pool.query(`SELECT count(*) AS n FROM ${schema}.${name}`)).rows[0].n);
  }

  test("a COMMIT whose answer is lost after Postgres ran it is not run again", async () => {
    const rows = await fresh("after_commit");
    const attempts: number[] = [];
    proxy.cutCommit("after");
    const out = await transaction(pool, async (tx, attempt) => {
      attempts.push(attempt);
      await tx.query(`INSERT INTO ${schema}.after_commit VALUES (1)`);
      return "written";
    });
    expect([out, attempts, await rows()]).toEqual(["written", [0], 1]);
  });

  test("a COMMIT lost before Postgres saw it runs the transaction again, once", async () => {
    const rows = await fresh("before_commit");
    const attempts: number[] = [];
    proxy.cutCommit("before");
    await transaction(pool, async (tx, attempt) => {
      attempts.push(attempt);
      await tx.query(`INSERT INTO ${schema}.before_commit VALUES (1)`);
    });
    expect([attempts, await rows()]).toEqual([[0, 1], 1]);
  });

  test("a connection lost in the middle of a transaction runs all of it again", async () => {
    const rows = await fresh("midway");
    const attempts: number[] = [];
    await transaction(pool, async (tx, attempt) => {
      attempts.push(attempt);
      await tx.query(`INSERT INTO ${schema}.midway VALUES (1)`);
      if (attempt === 0) proxy.cut();
      await tx.query(`INSERT INTO ${schema}.midway VALUES (2)`);
    });
    expect([attempts, await rows()]).toEqual([[0, 1], 2]);
  });

  test("idle connections that all die neither end the process nor fail the next query", async () => {
    await Promise.all([pool.query("SELECT 1"), pool.query("SELECT 1")]);
    proxy.cut();
    await new Promise((r) => setTimeout(r, 20));
    expect((await pool.query("SELECT 2 AS n")).rows).toEqual([{ n: 2 }]);
  });

  test("a database that's down for a while is waited for, and its return announced", async () => {
    const retries: number[] = [];
    const back: number[] = [];
    const p = new RetryingPool(
      { connectionString: proxy.url, max: 1 },
      { firstWaitMs: 50, onRetry: (_, n) => retries.push(n), onBack: (n) => back.push(n) },
    );
    try {
      proxy.down(300);
      expect((await p.query("SELECT 3 AS n")).rows).toEqual([{ n: 3 }]);
      expect(retries.length).toBeGreaterThan(0);
      expect(back).toEqual([retries.length]);
    } finally {
      await p.end();
    }
  });

  test("a database that stays down fails with its own error after the last try", async () => {
    const p = new RetryingPool(
      { connectionString: proxy.url, max: 1 },
      { tries: 3, firstWaitMs: 10 },
    );
    try {
      proxy.down(2_000);
      const e = await p.query("SELECT 1").catch((x: unknown) => x);
      expect(lostConnection(e)).toBe(true);
    } finally {
      await p.end();
      proxy.down(0);
    }
  });
});
