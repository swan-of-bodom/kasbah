import pg from "pg";
import { afterAll, expect, test } from "vitest";
import { EventCache, feltHex, packFelts, packFeltsHex, unpackFelts } from "../../src/db/cache.ts";
import type { BlockHeader, EmittedEvent } from "../../src/rpc/methods.ts";
import { felt } from "../../src/types/felt.ts";
import { header } from "../fixtures/header.ts";

const url = process.env.DATABASE_URL;
const CHAIN = "0x7e57";
let pool: pg.Pool | undefined;

afterAll(async () => {
  if (pool === undefined) return;
  await pool.query(`DROP SCHEMA IF EXISTS kasbah_cache_${CHAIN} CASCADE`);
  await pool.end();
});

test("felts pack to minimal bytes and back", () => {
  const felts = [
    "0x0",
    "0x1",
    "0xff",
    "0x100",
    "0x7e57c0ffee",
    `0x${"f".repeat(63)}`,
    "0x00000000000000000000000000000000000000000000000000000000000001",
  ];
  expect(unpackFelts(packFelts(felts))).toEqual([
    "0x0",
    "0x1",
    "0xff",
    "0x100",
    "0x7e57c0ffee",
    `0x${"f".repeat(63)}`,
    "0x1",
  ]);
  expect(packFelts(["0x0", "0x5"]).length).toBe(3);
});

const viaBigInt = (felts: string[]) =>
  Buffer.concat(
    felts.flatMap((f) => {
      let h = BigInt(f).toString(16);
      if (h === "0") h = "";
      else if (h.length % 2 === 1) h = `0${h}`;
      const b = Buffer.from(h, "hex");
      return [Buffer.from([b.length]), b];
    }),
  ).toString("hex");

test("felts encode from their hex text as they did through BigInt", () => {
  const edge = [
    "0x0",
    "0x00",
    "0x1",
    "0x01",
    "0xA",
    "0xabc",
    "0x0abc",
    `0x${"f".repeat(64)}`,
    `0x0${"e".repeat(63)}`,
  ];
  let s = 7;
  const rand = () => (s = (s * 1103515245 + 12345) % 2 ** 31);
  const random = Array.from({ length: 2000 }, () => {
    const n = 1 + (rand() % 64);
    return `0x${Array.from({ length: n }, () => "0123456789abcdefABCDEF"[rand() % 22]).join("")}`;
  });
  for (const f of [...edge, ...random]) expect(packFeltsHex([f])).toBe(viaBigInt([f]));
  expect(packFeltsHex(random)).toBe(viaBigInt(random));
  expect(packFelts(edge).toString("hex")).toBe(viaBigInt(edge));
  expect(feltHex("0x0")).toBe("");
  expect(() => feltHex("12")).toThrow(/not a felt/);
  expect(() => feltHex(`0x${"1".repeat(65)}`)).toThrow(/not a felt/);
});

test.skipIf(url === undefined)(
  "reads back every event once, in order, never ending a batch inside a block",
  async () => {
    pool = new pg.Pool({ connectionString: url, max: 2 });
    await pool.query(`DROP SCHEMA IF EXISTS kasbah_cache_${CHAIN} CASCADE`);
    const cache = await EventCache.open(pool, CHAIN);

    let s = 5;
    const rand = (n: number) =>
      Math.floor(((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * n);
    const events: EmittedEvent[] = [];
    for (let b = 100; b < 400; b++) {
      // Mostly sparse, some blocks larger than the read limit.
      const n = b % 50 === 0 ? 25 : rand(3);
      for (let i = 0; i < n; i++) {
        events.push({
          from_address: i % 3 === 0 ? "0xa" : "0xb",
          keys: ["0x51", `0x${i.toString(16)}`],
          data: [`0x${(b * 100 + i).toString(16)}`, "0x0"],
          block_number: b,
          block_hash: `0x${b.toString(16)}h`.replace("h", "1"),
          transaction_hash: `0x${b}${i}`,
          transaction_index: i,
          event_index: 0,
        });
      }
    }
    cache.track(["0xa", "0xb"], ["0x51"], 100);
    cache.add(events);
    cache.take(399);
    const c = await pool.connect();
    await c.query("BEGIN");
    await cache.persist(c);
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
      const next = events.find((e) => e.block_number! > batch.through);
      if (next !== undefined)
        expect(batch.events.some((e) => e.block_number === next.block_number)).toBe(false);
      through = batch.through;
      seen.push(...batch.events);
    }
    expect(through).toBe(399);
    expect(seen).toEqual(events);

    const onlyA: EmittedEvent[] = [];
    for await (const batch of cache.read(["0xa"], ["0x51"], 150, 260, 4))
      onlyA.push(...batch.events);
    expect(onlyA).toEqual(
      events.filter(
        (e) => e.from_address === "0xa" && e.block_number! >= 150 && e.block_number! <= 260,
      ),
    );
  },
);

test.skipIf(url === undefined)(
  "a range tracked while a commit writes the cache is covered from its own start only",
  async () => {
    pool ??= new pg.Pool({ connectionString: url, max: 2 });
    await pool.query(`DROP SCHEMA IF EXISTS kasbah_cache_${CHAIN} CASCADE`);
    const cache = await EventCache.open(pool, CHAIN);
    const event = (address: string, block: number): EmittedEvent => ({
      from_address: address,
      keys: ["0x51"],
      data: [],
      block_number: block,
      block_hash: "0x1",
      transaction_hash: `0x${block.toString(16)}`,
      transaction_index: 0,
      event_index: 0,
    });
    const commit = async (through: number, meanwhile = () => {}) => {
      cache.take(through);
      const c = await pool!.connect();
      await c.query("BEGIN");
      const persisting = cache.persist(c);
      meanwhile();
      await persisting;
      await c.query("COMMIT");
      c.release();
    };
    cache.track(["0xa"], ["0x51"], 100);
    cache.add([event("0xa", 150)]);
    // 0xb starts at block 300: its range is fetched while blocks 100–199 are being written.
    await commit(199, () => {
      cache.track(["0xa", "0xb"], ["0x51"], 300);
      cache.add([event("0xa", 310), event("0xb", 320)]);
    });
    await commit(349);
    expect(await cache.coveredUntil(["0xa"], ["0x51"], 100)).toBe(200);
    expect(await cache.coveredUntil(["0xb"], ["0x51"], 200)).toBe(200);
    expect(await cache.coveredUntil(["0xa", "0xb"], ["0x51"], 300)).toBe(350);
    const read: number[] = [];
    for await (const b of cache.read(["0xa", "0xb"], ["0x51"], 300, 349))
      for (const e of b.events) read.push(e.block_number!);
    expect(read).toEqual([310, 320]);
  },
);

test.skipIf(url === undefined)(
  "call results: kept up to the cap, oldest dropped first; info and clear",
  async () => {
    pool ??= new pg.Pool({ connectionString: url, max: 2 });
    await pool.query(`DROP SCHEMA IF EXISTS kasbah_cache_${CHAIN} CASCADE`);
    let cache = await EventCache.open(pool, CHAIN, { maxCalls: 10 });
    const persist = async () => {
      cache.take(-1);
      const c = await pool!.connect();
      await c.query("BEGIN");
      await cache.persist(c);
      await c.query("COMMIT");
      c.release();
    };
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 5; i++)
        cache.rememberCall("0xe", "0x5e1", [`0x${i}`], round, [`0x${round}${i}`]);
      await persist();
    }
    // 25 written: past 10 it drops to 9, so rounds 3 and 4 are left with one of round 2.
    const left = Number(
      (await pool.query(`SELECT count(*) AS n FROM kasbah_cache_${CHAIN}.calls`)).rows[0].n,
    );
    expect(left).toBeLessThanOrEqual(10);
    expect(await cache.getCall("0xe", "0x5e1", ["0x4"], 4)).toEqual(["0x44"]);
    expect(await cache.getCall("0xe", "0x5e1", ["0x0"], 0)).toBeUndefined();

    cache = await EventCache.open(pool, CHAIN, { maxCalls: 4 });
    expect(
      Number((await pool.query(`SELECT count(*) AS n FROM kasbah_cache_${CHAIN}.calls`)).rows[0].n),
    ).toBeLessThanOrEqual(4);
    expect(await cache.getCall("0xe", "0x5e1", ["0x4"], 4)).toEqual(["0x44"]);

    const info = (await EventCache.info(pool, CHAIN)).find(
      (i) => i.schema === `kasbah_cache_${CHAIN}`,
    )!;
    expect(info.calls).toBeGreaterThan(0);
    expect(info.bytes).toBeGreaterThan(0);
    await EventCache.clear(pool, { calls: true }, CHAIN);
    expect(
      (await EventCache.info(pool, CHAIN)).find((i) => i.schema === `kasbah_cache_${CHAIN}`)!.calls,
    ).toBe(0);
  },
);

test.skipIf(url === undefined)(
  "headers: the whole header round-trips; rows cached with only a timestamp are fetched again",
  async () => {
    pool ??= new pg.Pool({ connectionString: url, max: 2 });
    const cache = await EventCache.open(pool, CHAIN);
    const s = `kasbah_cache_${CHAIN}`;
    await pool.query(`DELETE FROM ${s}.headers`);
    const {
      transactions: _,
      status: __,
      ...h
    } = header({
      block_hash: "0xb7",
      parent_hash: "0xb6",
      block_number: 7,
      timestamp: 1_700_000_000,
    });
    const full: BlockHeader = {
      ...h,
      l2_gas_price: { price_in_fri: "0x4d0f395fc", price_in_wei: "0x6047f" },
    };
    // An old row, from before the header column.
    await pool.query(
      `INSERT INTO ${s}.headers (block, hash, parent, timestamp) VALUES (8, '\\x08', '\\x07', 1)`,
    );
    expect([...(await cache.headers([7, 8])).keys()]).toEqual([]);

    await cache.saveHeaders([
      full,
      { ...full, block_number: 8, block_hash: "0xb8", parent_hash: "0xb7" },
    ]);
    const found = await cache.headers([7, 8]);
    expect(found.get(7)).toMatchObject({
      number: 7,
      hash: felt("0xb7"),
      parentHash: felt("0xb6"),
      timestamp: 1_700_000_000,
      l1DaMode: "BLOB",
      starknetVersion: "0.14.0",
    });
    expect(found.get(7)!.l2GasPrice).toEqual({ fri: 0x4d0f395fcn, wei: 0x6047fn });
    expect(found.get(8)!.hash).toBe(felt("0xb8"));
  },
);
