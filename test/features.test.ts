import { createServer, type Server } from "node:http";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { selector } from "../src/abi/selector.ts";
import { bignum, kasbah } from "../src/index.ts";
import type { EmittedEvent } from "../src/rpc/methods.ts";

const url = process.env.DATABASE_URL;
const FACTORY = "0xfac";
const FACTORY_DEPLOYED = 5;
const UPGRADE_AT = 350;

const factoryAbi = [
  { type: "event", name: "f::Created", kind: "struct", members: [{ name: "pool", type: "core::starknet::contract_address::ContractAddress", kind: "data" }] },
  { type: "event", name: "f::Event", kind: "enum", variants: [{ name: "Created", type: "f::Created", kind: "nested" }] },
  { type: "function", name: "last_child", inputs: [], outputs: [{ type: "core::starknet::contract_address::ContractAddress" }], state_mutability: "view" },
] as const;
const amount = { name: "amount", type: "core::integer::u128", kind: "data" } as const;
const childA = [
  { type: "event", name: "c::Counted", kind: "struct", members: [amount] },
  { type: "event", name: "c::Event", kind: "enum", variants: [{ name: "Counted", type: "c::Counted", kind: "nested" }] },
] as const;
const childB = [
  { type: "event", name: "c::Counted", kind: "struct", members: [amount] },
  { type: "event", name: "c::Doubled", kind: "struct", members: [amount] },
  { type: "event", name: "c::Event", kind: "enum", variants: [{ name: "Counted", type: "c::Counted", kind: "nested" }, { name: "Doubled", type: "c::Doubled", kind: "nested" }] },
] as const;

const pools = pgTable("pools", { address: text().primaryKey(), total: bignum().notNull(), events: integer().notNull(), created: integer().notNull() });
const ticks = pgTable("ticks", { block: integer().primaryKey(), timestamp: integer().notNull(), last: text().notNull() });

type Block = { number: number; hash: string; parent: string; events: EmittedEvent[]; created: string[] };

/** A chain where a factory creates children that emit events; one child is upgraded to a class with a new event. */
function fakeNode() {
  let s = 11;
  const rand = (n: number) => Math.floor(((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * n);
  let fork = 0;
  const blocks: Block[] = [];
  const createdAt = new Map<string, number>();
  let upgraded: string | undefined;
  const calls = new Map<string, number>();

  const add = () => {
    const number = blocks.length;
    const hash = `0x${number.toString(16)}f${fork}`;
    const events: EmittedEvent[] = [];
    const created: string[] = [];
    const live = blocks.flatMap((b) => b.created);
    let tx = 0;
    const emit = (address: string, name: string, value: string) =>
      events.push({ from_address: address, keys: [selector(name)], data: [value], block_number: number, block_hash: hash, transaction_hash: `0x${number.toString(16)}${tx}f${fork}`, transaction_index: tx++, event_index: 0 });
    if (number >= FACTORY_DEPLOYED) {
      const n = number < 100 ? 1 + rand(2) : rand(4) === 0 ? 1 : 0;
      for (let i = 0; i < n; i++) {
        const child = `0x${(0x100000 + number * 16 + i).toString(16)}${fork.toString(16)}`;
        created.push(child);
        emit(FACTORY, "Created", child);
      }
      for (let i = 0; i < rand(5) && live.length > 0; i++) {
        const child = live[rand(live.length)]!;
        const name = child === upgraded && number >= UPGRADE_AT && rand(2) === 0 ? "Doubled" : "Counted";
        emit(child, name, `0x${(1 + rand(9)).toString(16)}`);
      }
    }
    for (const c of created) createdAt.set(c, number);
    blocks.push({ number, hash, parent: blocks.at(-1)?.hash ?? "0x0", events, created });
    if (upgraded === undefined && number >= 20) upgraded = blocks.flatMap((b) => b.created)[0];
  };
  const reorg = (depth: number) => {
    fork++;
    for (const b of blocks.splice(blocks.length - depth, depth)) for (const c of b.created) createdAt.delete(c);
    for (let i = 0; i < depth; i++) add();
  };

  const notFound = { code: 24, message: "Block not found" };
  const at = (params: any) => {
    const n = params.block_id.block_number;
    if (blocks[n] === undefined) throw notFound;
    return n;
  };
  const call = (method: string, params: any): unknown => {
    calls.set(method, (calls.get(method) ?? 0) + (method === "starknet_getEvents" && params.filter.address === "0x1" ? 0 : 1));
    switch (method) {
      case "starknet_specVersion":
        return "0.10.4";
      case "pathfinder_version":
        return "fake";
      case "starknet_chainId":
        return "0x46414b45";
      case "starknet_blockNumber":
        return blocks.length - 1;
      case "starknet_blockHashAndNumber":
        return { block_hash: blocks.at(-1)!.hash, block_number: blocks.length - 1 };
      case "starknet_getBlockWithTxHashes": {
        const b = blocks[at(params)]!;
        return { block_hash: b.hash, parent_hash: b.parent, block_number: b.number, timestamp: 1_000 + b.number * 2, status: "ACCEPTED_ON_L2", transactions: [] };
      }
      case "starknet_getStateUpdate": {
        const n = at(params);
        return { state_diff: { replaced_classes: n === UPGRADE_AT && upgraded !== undefined ? [{ contract_address: upgraded, class_hash: "0xcb" }] : [] } };
      }
      case "starknet_getClassHashAt": {
        const n = at(params);
        const a = `0x${BigInt(params.contract_address).toString(16)}`;
        if (a === FACTORY && n >= FACTORY_DEPLOYED) return "0xfa";
        const created = createdAt.get(a);
        if (created === undefined || n < created) throw { code: 20, message: "Contract not found" };
        return a === upgraded && n >= UPGRADE_AT ? "0xcb" : "0xca";
      }
      case "starknet_call": {
        const id = params.block_id;
        const b = id.block_hash !== undefined ? blocks.find((x) => x.hash === id.block_hash) : blocks[id.block_number];
        if (b === undefined) throw notFound;
        if (BigInt(params.request.contract_address) !== BigInt(FACTORY) || params.request.entry_point_selector !== selector("last_child")) throw { code: 21, message: "Entrypoint not found" };
        return [blocks.slice(0, b.number + 1).flatMap((x) => x.created).at(-1) ?? "0x0"];
      }
      case "starknet_getClass":
        return { abi: JSON.stringify(params.class_hash === "0xfa" ? factoryAbi : params.class_hash === "0xca" ? childA : childB) };
      case "starknet_getEvents": {
        const f = params.filter;
        const addresses = new Set([f.address].flat().map((x: string) => BigInt(x)));
        const wanted = f.keys?.[0] === undefined ? undefined : new Set(f.keys[0]);
        let [from, skip] = f.continuation_token === undefined ? [f.from_block.block_number, 0] : f.continuation_token.split("-").map(Number);
        const out: EmittedEvent[] = [];
        for (let b = from; b <= Math.min(f.to_block.block_number, blocks.length - 1); b++) {
          const matched = blocks[b]!.events.filter((e) => addresses.has(BigInt(e.from_address)) && (wanted === undefined || wanted.has(e.keys[0]!)));
          for (const [i, e] of matched.entries()) {
            if (b === from && i < skip) continue;
            if (out.length === f.chunk_size) return { events: out, continuation_token: `${b}-${i}` };
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
  return { blocks, add, reorg, server, calls, children: () => blocks.flatMap((b) => b.created), upgraded: () => upgraded };
}

const node = fakeNode();
let rpcUrl: string;

beforeAll(async () => {
  for (let i = 0; i < 300; i++) node.add();
  await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
  const a = node.server.address();
  rpcUrl = `http://127.0.0.1:${typeof a === "object" && a !== null ? a.port : 0}`;
});

afterAll(async () => {
  node.server.close();
  if (url === undefined) return;
  const p = new pg.Pool({ connectionString: url, max: 1 });
  await p.query(`DROP SCHEMA IF EXISTS kasbah_test_features CASCADE; DROP SCHEMA IF EXISTS kasbah_test_cached CASCADE; DROP SCHEMA IF EXISTS kasbah_cache_0x46414b45 CASCADE`);
  await p.end();
});

function app(schema: string, cache = false, extra: { ws?: string; pollMs?: number } = {}) {
  const a = kasbah({
    rpc: rpcUrl,
    database: url!,
    schema,
    contracts: { Pool: { abi: childB, factory: { address: FACTORY, abi: factoryAbi, event: "Created", parameter: "pool" }, startBlock: FACTORY_DEPLOYED } },
    blocks: { Every10: { interval: 10, startBlock: 0 } },
    tables: { pools, ticks },
    reorgWindow: 16,
    pollMs: 5,
    concurrency: 4,
    cache,
    ...extra,
  });
  a.on("Pool:Counted", async ({ event, context }) => {
    const v = event.args.amount;
    await context.db.insert(pools).values({ address: event.address, total: v, events: 1, created: event.block.number })
      .onConflictDoUpdate((r) => ({ total: r.total + v, events: r.events + 1 }));
  });
  a.on("Pool:Doubled", async ({ event, context }) => {
    await context.db.update(pools, { address: event.address }).set((r) => ({ total: r.total * 2n, events: r.events + 1 }));
  });
  a.on("Every10:block", async ({ event, context }) => {
    const last = await context.client.read({ abi: factoryAbi, address: FACTORY, functionName: "last_child" });
    await context.db.insert(ticks).values({ block: event.block.number, timestamp: event.block.timestamp, last });
  });
  return a;
}

const query = async (sql: string) => {
  const p = new pg.Pool({ connectionString: url, max: 1 });
  try {
    return (await p.query(sql)).rows;
  } finally {
    await p.end();
  }
};
const checkpoint = async (schema: string) => {
  try {
    return (await query(`SELECT value FROM ${schema}._kasbah_meta WHERE key = 'checkpoint'`))[0]?.value as number | undefined;
  } catch {
    return undefined;
  }
};
async function until(condition: () => Promise<boolean>, ms = 30_000) {
  const end = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** What the tables must hold for the canonical chain up to `to`. */
function expected(to: number) {
  const totals = new Map<string, { total: bigint; events: number; created: number }>();
  for (const b of node.blocks.slice(0, to + 1)) {
    for (const e of b.events) {
      if (BigInt(e.from_address) === BigInt(FACTORY)) continue;
      const a = `0x${BigInt(e.from_address).toString(16).padStart(64, "0")}`;
      const t = totals.get(a);
      if (e.keys[0] === selector("Counted")) {
        if (t === undefined) totals.set(a, { total: BigInt(e.data[0]!), events: 1, created: b.number });
        else totals.set(a, { ...t, total: t.total + BigInt(e.data[0]!), events: t.events + 1 });
      } else totals.set(a, { ...t!, total: t!.total * 2n, events: t!.events + 1 });
    }
  }
  return {
    pools: [...totals].map(([address, t]) => ({ address, total: t.total.toString(), events: t.events, created: t.created })).sort((x, y) => x.address.localeCompare(y.address)),
    ticks: node.blocks.slice(0, to + 1).filter((b) => b.number % 10 === 0)
      .map((b) => ({ block: b.number, timestamp: 1_000 + b.number * 2, last: `0x${BigInt(node.blocks.slice(0, b.number + 1).flatMap((x) => x.created).at(-1) ?? "0x0").toString(16).padStart(64, "0")}` })),
  };
}
const actual = async (schema: string) => ({
  pools: await query(`SELECT address, total::text, events, created FROM ${schema}.pools ORDER BY address COLLATE "C"`),
  ticks: await query(`SELECT block, timestamp, last FROM ${schema}.ticks ORDER BY block`),
});

test.skipIf(url === undefined)("factories, block handlers, reorgs and an upgrade through the state diff", async () => {
  const schema = "kasbah_test_features";
  const logs: string[] = [];
  const caughtUp = () => until(async () => (await checkpoint(schema)) === node.blocks.length - 1);

  let stop = new AbortController();
  let run = app(schema).run({ reset: true, signal: stop.signal, log: (l) => logs.push(l) });
  await caughtUp();
  for (let i = 0; i < 160; i++) {
    node.add();
    if (i % 10 === 0) await new Promise((r) => setTimeout(r, 10));
    if (i % 50 === 49) {
      await caughtUp();
      node.reorg(8 + (i % 4));
      await caughtUp();
    }
  }
  await caughtUp();
  stop.abort();
  await run;

  for (let i = 0; i < 40; i++) node.add();
  node.reorg(44);
  stop = new AbortController();
  run = app(schema).run({ signal: stop.signal, log: (l) => logs.push(l) });
  await caughtUp();
  stop.abort();
  await run;

  const tip = node.blocks.length - 1;
  expect(await actual(schema)).toEqual(expected(tip));
  const children = await query(`SELECT count(*)::int AS n FROM ${schema}._kasbah_children`);
  expect(children[0].n).toBe(node.children().length);
  expect(node.children().length).toBeGreaterThan(100);
  expect(logs.some((l) => l.includes(`class replaced at block ${UPGRADE_AT}`))).toBe(true);
  expect(node.calls.get("starknet_getStateUpdate")).toBeGreaterThan(0);
  expect(logs.filter((l) => l.startsWith("reorg")).length).toBeGreaterThanOrEqual(4);
}, 120_000);

test.skipIf(url === undefined)("a re-index reads the cache and fetches no events", async () => {
  const schema = "kasbah_test_cached";
  const to = node.blocks.length - 20;
  await app(schema, true).run({ reset: true, to, log: () => {} });
  expect(await actual(schema)).toEqual(expected(to));

  const before = node.calls.get("starknet_getEvents") ?? 0;
  const headersBefore = node.calls.get("starknet_getBlockWithTxHashes") ?? 0;
  const callsBefore = node.calls.get("starknet_call") ?? 0;
  const logs: string[] = [];
  await app(schema, true).run({ reset: true, to, log: (l) => logs.push(l) });
  expect(await actual(schema)).toEqual(expected(to));
  expect(node.calls.get("starknet_getEvents")).toBe(before);
  expect(node.calls.get("starknet_getBlockWithTxHashes")).toBe(headersBefore);
  expect(node.calls.get("starknet_call")).toBe(callsBefore);
  expect(logs.some((l) => / 0 fetched\)/.test(l))).toBe(true);

  // Past the cached range, only the new blocks are fetched.
  await app(schema, true).run({ to: node.blocks.length - 1, log: () => {} });
  expect(await actual(schema)).toEqual(expected(node.blocks.length - 1));
}, 120_000);

test.skipIf(url === undefined)("with a head subscription, new blocks are indexed without waiting for the poll", async () => {
  const schema = "kasbah_test_features";
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.on("listening", r));
  wss.on("connection", (s) => s.on("message", (m) => s.send(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(String(m)).id, result: "0x7" }))));
  const announce = () => {
    for (const s of wss.clients) s.send(JSON.stringify({ jsonrpc: "2.0", method: "starknet_subscriptionNewHeads", params: { subscription_id: "0x7", result: {} } }));
  };
  const stop = new AbortController();
  const logs: string[] = [];
  const run = app(schema, false, { ws: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`, pollMs: 60_000 }).run({ signal: stop.signal, log: (l) => logs.push(l) });
  try {
    await until(async () => (await checkpoint(schema)) === node.blocks.length - 1);
    for (let i = 0; i < 5; i++) {
      node.add();
      const started = Date.now();
      announce();
      await until(async () => (await checkpoint(schema)) === node.blocks.length - 1, 5_000);
      expect(Date.now() - started).toBeLessThan(5_000);
    }
  } finally {
    stop.abort();
    await run;
    wss.close();
  }
  expect(await actual(schema)).toEqual(expected(node.blocks.length - 1));
  expect(logs).toContain("WebSocket: following new heads");
}, 60_000);
