import pg from "pg";
import { afterAll, expect, test } from "vitest";
import { EventCache, packFelts, unpackFelts } from "../src/cache.ts";
import type { EmittedEvent } from "../src/rpc/methods.ts";

const url = process.env.DATABASE_URL;
const CHAIN = "0x7e57";
let pool: pg.Pool | undefined;

afterAll(async () => {
  if (pool === undefined) return;
  await pool.query(`DROP SCHEMA IF EXISTS kasbah_cache_${CHAIN} CASCADE`);
  await pool.end();
});

test("felts pack to minimal bytes and back", () => {
  const felts = ["0x0", "0x1", "0xff", "0x100", "0x7e57c0ffee", `0x${"f".repeat(63)}`, "0x00000000000000000000000000000000000000000000000000000000000001"];
  expect(unpackFelts(packFelts(felts))).toEqual(["0x0", "0x1", "0xff", "0x100", "0x7e57c0ffee", `0x${"f".repeat(63)}`, "0x1"]);
  expect(packFelts(["0x0", "0x5"]).length).toBe(3);
});

test.skipIf(url === undefined)("reads back every event once, in order, never ending a batch inside a block", async () => {
  pool = new pg.Pool({ connectionString: url, max: 2 });
  await pool.query(`DROP SCHEMA IF EXISTS kasbah_cache_${CHAIN} CASCADE`);
  const cache = await EventCache.open(pool, CHAIN);

  let s = 5;
  const rand = (n: number) => Math.floor(((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * n);
  const events: EmittedEvent[] = [];
  for (let b = 100; b < 400; b++) {
    // Mostly sparse, some blocks larger than the read limit.
    const n = b % 50 === 0 ? 25 : rand(3);
    for (let i = 0; i < n; i++) {
      events.push({ from_address: i % 3 === 0 ? "0xa" : "0xb", keys: ["0x51", `0x${i.toString(16)}`], data: [`0x${(b * 100 + i).toString(16)}`, "0x0"], block_number: b, block_hash: `0x${b.toString(16)}h`.replace("h", "1"), transaction_hash: `0x${b}${i}`, transaction_index: i, event_index: 0 });
    }
  }
  cache.track(["0xa", "0xb"], ["0x51"], 100);
  cache.add(events);
  const c = await pool.connect();
  await c.query("BEGIN");
  await cache.persist(c, 399);
  await c.query("COMMIT");
  c.release();

  expect(await cache.coveredUntil(["0xa", "0xb"], ["0x51"], 100)).toBe(400);
  expect(await cache.coveredUntil(["0xa", "0xc"], ["0x51"], 100)).toBe(100);
  expect(await cache.coveredUntil(["0xa"], ["0x51"], 250)).toBe(400);

  const seen: EmittedEvent[] = [];
  let through = 99;
  for await (const batch of cache.read(["0xa", "0xb"], ["0x51"], 100, 399, 7)) {
    expect(batch.through).toBeGreaterThan(through);
    for (const e of batch.events) {
      expect(e.block_number).toBeGreaterThan(through);
      expect(e.block_number).toBeLessThanOrEqual(batch.through);
    }
    // Nothing of a block in this batch is left for the next one.
    const next = events.find((e) => e.block_number! > batch.through);
    if (next !== undefined) expect(batch.events.some((e) => e.block_number === next.block_number)).toBe(false);
    through = batch.through;
    seen.push(...batch.events);
  }
  expect(through).toBe(399);
  expect(seen).toEqual(events);

  const onlyA: EmittedEvent[] = [];
  for await (const batch of cache.read(["0xa"], ["0x51"], 150, 260, 4)) onlyA.push(...batch.events);
  expect(onlyA).toEqual(events.filter((e) => e.from_address === "0xa" && e.block_number! >= 150 && e.block_number! <= 260));
});

test.skipIf(url === undefined)("call results: kept up to the cap, oldest dropped first; info and clear", async () => {
  pool ??= new pg.Pool({ connectionString: url, max: 2 });
  await pool.query(`DROP SCHEMA IF EXISTS kasbah_cache_${CHAIN} CASCADE`);
  let cache = await EventCache.open(pool, CHAIN, { maxCalls: 10 });
  const persist = async () => {
    const c = await pool!.connect();
    await c.query("BEGIN");
    await cache.persist(c, -1);
    await c.query("COMMIT");
    c.release();
  };
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < 5; i++) cache.rememberCall("0xe", "0x5e1", [`0x${i}`], round, [`0x${round}${i}`]);
    await persist();
  }
  // 25 written: past 10 it drops to 9, so rounds 3 and 4 are left with one of round 2.
  const left = Number((await pool.query(`SELECT count(*) AS n FROM kasbah_cache_${CHAIN}.calls`)).rows[0].n);
  expect(left).toBeLessThanOrEqual(10);
  expect(await cache.getCall("0xe", "0x5e1", ["0x4"], 4)).toEqual(["0x44"]);
  expect(await cache.getCall("0xe", "0x5e1", ["0x0"], 0)).toBeUndefined();

  // A smaller cap at the next open prunes at once.
  cache = await EventCache.open(pool, CHAIN, { maxCalls: 4 });
  expect(Number((await pool.query(`SELECT count(*) AS n FROM kasbah_cache_${CHAIN}.calls`)).rows[0].n)).toBeLessThanOrEqual(4);
  expect(await cache.getCall("0xe", "0x5e1", ["0x4"], 4)).toEqual(["0x44"]);

  const info = (await EventCache.info(pool)).find((i) => i.schema === `kasbah_cache_${CHAIN}`)!;
  expect(info.calls).toBeGreaterThan(0);
  expect(info.bytes).toBeGreaterThan(0);
  await EventCache.clear(pool, { calls: true }, CHAIN);
  expect((await EventCache.info(pool)).find((i) => i.schema === `kasbah_cache_${CHAIN}`)!.calls).toBe(0);
});
