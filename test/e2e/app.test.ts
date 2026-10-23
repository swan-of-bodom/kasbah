import { createServer, type Server } from "node:http";
import { index, integer, pgTable, text } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { rawSelector as selector } from "../../src/abi/selector.ts";
import { liveChannel } from "../../src/api/server.ts";
import { bignum, kasbah, Status } from "../../src/index.ts";
import type { EmittedEvent } from "../../src/rpc/methods.ts";
import { header } from "../fixtures/header.ts";
import { faultyProxy } from "./faulty.ts";

const url = process.env.DATABASE_URL;
const schema = "kasbah_test_app";
const ADDRESS = "0xc0ffee";
const DEPLOYED = 10;
const UPGRADED = 300;

const member = { name: "amount", type: "core::integer::u128", kind: "data" } as const;
const counted = { type: "event", name: "t::Counted", kind: "struct", members: [member] } as const;
const doubled = { type: "event", name: "t::Doubled", kind: "struct", members: [member] } as const;
/** Announces the upgrade: the class is read again only when it's emitted, not at every poll. */
const upgraded = {
  type: "event",
  name: "t::Upgraded",
  kind: "struct",
  members: [{ name: "class_hash", type: "core::starknet::class_hash::ClassHash", kind: "data" }],
} as const;
const upgradedVariant = { name: "Upgraded", type: "t::Upgraded", kind: "nested" } as const;
const classA = [
  counted,
  upgraded,
  {
    type: "event",
    name: "t::Event",
    kind: "enum",
    variants: [{ name: "Counted", type: "t::Counted", kind: "nested" }, upgradedVariant],
  },
] as const;
const classB = [
  counted,
  doubled,
  upgraded,
  {
    type: "event",
    name: "t::Event",
    kind: "enum",
    variants: [
      { name: "Counted", type: "t::Counted", kind: "nested" },
      { name: "Doubled", type: "t::Doubled", kind: "nested" },
      upgradedVariant,
    ],
  },
] as const;

const totals = pgTable("totals", {
  id: text().primaryKey(),
  total: bignum().notNull(),
  events: integer().notNull(),
});
/** Append-only, keyed by transaction hash: filled without its key during the backfill. */
const log = pgTable("log", { id: text().primaryKey(), block: integer().notNull() }, (t) => [
  index().on(t.block),
]);

type Block = { number: number; hash: string; parent: string; events: EmittedEvent[] };

/** A JSON-RPC Starknet node over HTTP: a chain that grows and forks, and a contract that upgrades its class. */
function fakeNode() {
  let s = 3;
  const rand = (n: number) => Math.floor(((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * n);
  let fork = 0;
  const blocks: Block[] = [];
  const add = () => {
    const number = blocks.length;
    const hash = `0x${number.toString(16)}f${fork}`;
    const events: EmittedEvent[] = [];
    if (number >= DEPLOYED) {
      for (let i = 0; i < rand(4); i++) {
        const name = number >= UPGRADED && rand(3) === 0 ? "Doubled" : "Counted";
        events.push({
          from_address: ADDRESS,
          keys: [selector(name)],
          data: [`0x${(1 + rand(9)).toString(16)}`],
          block_number: number,
          block_hash: hash,
          transaction_hash: `0x${number}${i}`,
          transaction_index: i,
          event_index: 0,
        });
      }
    }
    if (number === UPGRADED)
      events.push({
        from_address: ADDRESS,
        keys: [selector("Upgraded")],
        data: ["0xb"],
        block_number: number,
        block_hash: hash,
        transaction_hash: `0x${number}u`,
        transaction_index: 9,
        event_index: 0,
      });
    blocks.push({ number, hash, parent: blocks.at(-1)?.hash ?? "0x0", events });
  };
  const reorg = (depth: number) => {
    fork++;
    blocks.splice(blocks.length - depth, depth);
    for (let i = 0; i < depth; i++) add();
  };

  const headerAt = (n: number) => {
    const b = blocks[n];
    if (b === undefined) throw { code: 24, message: "Block not found" };
    return header({
      block_hash: b.hash,
      parent_hash: b.parent,
      block_number: b.number,
      timestamp: n,
    });
  };
  const calls = new Map<string, number>();
  const call = (method: string, params: any): unknown => {
    calls.set(method, (calls.get(method) ?? 0) + 1);
    switch (method) {
      case "starknet_specVersion":
        return "0.10.4";
      case "pathfinder_version":
        return "fake";
      case "starknet_chainId":
        return "0x1";
      case "starknet_blockNumber":
        return blocks.length - 1;
      case "starknet_blockHashAndNumber":
        return { block_hash: blocks.at(-1)!.hash, block_number: blocks.length - 1 };
      case "starknet_getBlockWithTxHashes":
        return headerAt(params.block_id.block_number);
      case "starknet_getClassHashAt": {
        const n = params.block_id.block_number;
        if (n > blocks.length - 1) throw { code: 24, message: "Block not found" };
        if (n < DEPLOYED || BigInt(params.contract_address) !== BigInt(ADDRESS))
          throw { code: 20, message: "Contract not found" };
        return n < UPGRADED ? "0xa" : "0xb";
      }
      case "starknet_getClass":
        return { abi: JSON.stringify(params.class_hash === "0xa" ? classA : classB) };
      case "starknet_getEvents": {
        const f = params.filter;
        const addresses = new Set([f.address].flat().map((a: string) => BigInt(a)));
        const wanted = f.keys?.[0] === undefined ? undefined : new Set(f.keys[0]);
        let [from, skip] =
          f.continuation_token === undefined
            ? [f.from_block.block_number, 0]
            : f.continuation_token.split("-").map(Number);
        const out: EmittedEvent[] = [];
        for (let b = from; b <= Math.min(f.to_block.block_number, blocks.length - 1); b++) {
          const matched = blocks[b]!.events.filter(
            (e) =>
              addresses.has(BigInt(e.from_address)) &&
              (wanted === undefined || wanted.has(e.keys[0]!)),
          );
          for (const [i, e] of matched.entries()) {
            if (b === from && i < skip) continue;
            if (out.length === f.chunk_size)
              return { events: out, continuation_token: `${b}-${i}` };
            out.push(e);
          }
          skip = 0;
        }
        return { events: out };
      }
    }
    throw { code: -32601, message: `no ${method}` };
  };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const answer = (r: { id: number; method: string; params: unknown }) => {
        try {
          return { jsonrpc: "2.0", id: r.id, result: call(r.method, r.params) };
        } catch (e) {
          return { jsonrpc: "2.0", id: r.id, error: e };
        }
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(answer) : answer(parsed)));
    });
  });
  return { blocks, add, reorg, server, calls };
}

const node = fakeNode();
let rpcUrl: string;

beforeAll(async () => {
  for (let i = 0; i < 200; i++) node.add();
  await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
  const a = node.server.address();
  rpcUrl = `http://127.0.0.1:${typeof a === "object" && a !== null ? a.port : 0}`;
});

afterAll(async () => {
  node.server.close();
  if (url === undefined) return;
  const p = new pg.Pool({ connectionString: url, max: 1 });
  await p.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await p.end();
});

function app(s = schema, rpc = rpcUrl) {
  const a = kasbah({
    rpc,
    database: url!,
    schema: s,
    contracts: { C: { abi: classB, address: ADDRESS, startBlock: DEPLOYED } },
    tables: { totals, log },
    reorgWindow: 16,
    pollMs: 5,
    concurrency: 4,
  });
  a.on("C:Counted", async ({ event, context }) => {
    await context.db
      .insert(log)
      .values({ id: `${event.transaction.hash}:${event.index}`, block: event.block.number });
    await context.db
      .insert(totals)
      .values({ id: "t", total: event.args.amount, events: 1 })
      .onConflictDoUpdate((r) => ({ total: r.total + event.args.amount, events: r.events + 1 }));
  });
  a.on("C:Doubled", async ({ event, context }) => {
    await context.db
      .insert(log)
      .values({ id: `${event.transaction.hash}:${event.index}`, block: event.block.number });
    await context.db
      .update(totals, { id: "t" })
      .set((r) => ({ total: r.total * 2n, events: r.events + 1 }));
  });
  return a;
}

/** The app's totals over the chain as it is now, through block `to`. */
function expectedTotals(to: number) {
  let total = 0n;
  let events = 0;
  for (const b of node.blocks.slice(0, to + 1)) {
    for (const e of b.events) {
      if (e.keys[0] === selector("Upgraded")) continue;
      if (e.keys[0] === selector("Counted")) total += BigInt(e.data[0]!);
      else total *= 2n;
      events++;
    }
  }
  return { total: total.toString(), events };
}

async function checkpoint(): Promise<number | undefined> {
  const p = new pg.Pool({ connectionString: url, max: 1 });
  try {
    return (await p.query(`SELECT value FROM ${schema}._kasbah_meta WHERE key = 'checkpoint'`))
      .rows[0]?.value;
  } catch {
    return undefined;
  } finally {
    await p.end();
  }
}

async function until(condition: () => Promise<boolean>, ms = 20_000) {
  const end = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test.skipIf(url === undefined)(
  "backfill, live, reorgs, a class upgrade and a restart end on the canonical state",
  async () => {
    const logs: string[] = [];
    /** A status whose notices' lines go to `logs`. */
    const watched = () => {
      const status = new Status();
      status.subscribe((n) => logs.push(n.text));
      return status;
    };

    // First run: backfill to the window, follow, grow past the upgrade with reorgs, then stop.
    let stop = new AbortController();
    let run = app().run({ reset: true, signal: stop.signal, status: watched() });
    await until(async () => (await checkpoint()) === node.blocks.length - 1);
    const caughtUp = () => until(async () => (await checkpoint()) === node.blocks.length - 1);
    for (let i = 0; i < 150; i++) {
      node.add();
      if (i % 10 === 0) await new Promise((r) => setTimeout(r, 15));
      // Reorgs of blocks already indexed, the last one of the head block alone.
      if (i % 40 === 39) {
        await caughtUp();
        node.reorg(1 + (i % 7));
        await caughtUp();
      }
    }
    await caughtUp();
    stop.abort();
    await run;

    // Down for a while: the chain moves on and reorgs 4 blocks below the last indexed one. The log table lost its
    // key, as when a backfill stops before the end: the restart finds out and builds it again.
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    await admin.query(`ALTER TABLE ${schema}.log DROP CONSTRAINT log_pkey`);
    await admin.end();
    for (let i = 0; i < 60; i++) node.add();
    node.reorg(64);
    stop = new AbortController();
    run = app().run({ signal: stop.signal, status: watched() });
    await until(async () => (await checkpoint()) === node.blocks.length - 1);
    stop.abort();
    await run;

    const { total, events } = expectedTotals(node.blocks.length - 1);
    const p = new pg.Pool({ connectionString: url, max: 1 });
    const { rows } = await p.query(`SELECT total::text, events FROM ${schema}.totals`);
    const logged = (
      await p.query(`SELECT count(*)::int AS n, count(DISTINCT id)::int AS ids FROM ${schema}.log`)
    ).rows[0];
    const keys = (
      await p.query(
        `SELECT conrelid::regclass::text AS t FROM pg_constraint WHERE connamespace = '${schema}'::regnamespace AND contype = 'p' ORDER BY 1`,
      )
    ).rows.map((r) => r.t);
    const indexes = (
      await p.query(
        `SELECT indexname FROM pg_indexes WHERE schemaname = '${schema}' AND tablename = 'log' ORDER BY 1`,
      )
    ).rows.map((r) => r.indexname);
    await p.end();
    expect(rows).toEqual([{ total, events }]);
    expect(logged).toEqual({ n: events, ids: events });
    expect(keys).toEqual(expect.arrayContaining([`${schema}.log`, `${schema}.totals`]));
    expect(indexes).toEqual(["log_block_index", "log_pkey"]);
    // Both tables keyed after the first backfill, then only the log table, whose key was dropped.
    expect(logs.filter((l) => / primary keys? built/.test(l)).map((l) => l.split(" ")[0])).toEqual([
      "2",
      "1",
    ]);
    expect(node.blocks.at(-1)!.number).toBeGreaterThan(UPGRADED);
    expect(logs.some((l) => l.includes(`class replaced at block ${UPGRADED}`))).toBe(true);
    // The class is read at startup (a bisection, twice) and at the Upgraded event, not at every poll (30 here).
    expect(node.calls.get("starknet_getClassHashAt")).toBeLessThan(20);
    expect(logs.filter((l) => l.startsWith("reorg:")).length).toBe(3);
    expect(logs.some((l) => l.startsWith("reorg while stopped"))).toBe(true);
  },
  60_000,
);

test.skipIf(url === undefined)("a backfill to `to` commits once, through `to`", async () => {
  const s = "kasbah_test_app_once";
  const listener = new pg.Client({ connectionString: url });
  await listener.connect();
  const notified: number[] = [];
  listener.on("notification", (n) => notified.push(JSON.parse(n.payload!).checkpoint));
  await listener.query(`LISTEN "${liveChannel(s)}"`);
  const status = new Status();
  const progress: string[] = [];
  status.subscribe((n) => n.kind === "progress" && progress.push(n.text));
  try {
    await app(s).run({ reset: true, to: 150, status });
    await new Promise((r) => setTimeout(r, 200));
    expect(notified).toEqual([150]);
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatch(/^block 150\/150 \(100\.0%\)/);
    expect([status.phase, status.checkpoint]).toEqual(["done", 150]);
    // Stored too: `serve` over the finished run answers /ready.
    const meta = await listener.query(`SELECT value FROM ${s}._kasbah_meta WHERE key = 'phase'`);
    expect(meta.rows[0].value).toBe("done");
  } finally {
    await listener.end();
    const p = new pg.Pool({ connectionString: url, max: 1 });
    await p.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    await p.end();
  }
});

test.skipIf(url === undefined)(
  "through a flaky endpoint (throttles, 503s, dropped connections, cut-off and partial answers) the state is the chain's",
  async () => {
    const s = "kasbah_test_app_faults";
    const proxy = await faultyProxy(rpcUrl, { share: 0.2 });
    const status = new Status();
    // Through the edge of the reorg window: the chain is past the upgrade once the first test has run.
    const to = node.blocks.length - 1 - 16;
    try {
      await app(s, proxy.url).run({ reset: true, to, status });
      const p = new pg.Pool({ connectionString: url, max: 1 });
      const { rows } = await p.query(`SELECT total::text, events FROM ${s}.totals`);
      await p.end();
      expect(rows).toEqual([expectedTotals(to)]);
      expect([status.phase, status.checkpoint]).toEqual(["done", to]);
      for (const n of Object.values(proxy.injected)) expect(n).toBeGreaterThan(0);
      expect(status.rpc!.retries).toBeGreaterThan(0);
    } finally {
      proxy.close();
      const p = new pg.Pool({ connectionString: url, max: 1 });
      await p.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
      await p.end();
    }
  },
  60_000,
);
