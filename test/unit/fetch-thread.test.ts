import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, expect, test } from "vitest";
import { EventCache } from "../../src/db/cache.ts";
import { Status } from "../../src/indexer/status.ts";
import { RpcClient } from "../../src/rpc/client.ts";
import type { EmittedEvent } from "../../src/rpc/methods.ts";
import { fetchThread } from "../../src/sync/fetch-thread.ts";

const url = process.env.DATABASE_URL;
const CHAIN = "0x7e58";
const BLOCKS = 2_000;
let pool: pg.Pool | undefined;
const servers: Server[] = [];

afterAll(async () => {
  for (const s of servers) s.close();
  if (pool === undefined) return;
  await pool.query(`DROP SCHEMA IF EXISTS kasbah_cache_${CHAIN} CASCADE`);
  await pool.end();
});

const events: EmittedEvent[] = Array.from({ length: BLOCKS / 4 }, (_, i) => ({
  from_address: "0xa",
  keys: ["0x51", `0x${i.toString(16)}`],
  data: [`0x${(i * 7).toString(16)}`],
  block_number: i * 4,
  block_hash: `0xb${(i * 4).toString(16)}`,
  transaction_hash: `0xc${i.toString(16)}`,
  transaction_index: 0,
  event_index: 0,
}));

/** A Pathfinder-like node over HTTP: at most 256 blocks per page, token `"<block>-<skipped>"`; `fail` answers an error. */
async function node(o: { delayMs?: number; fail?: { code: number; message: string } } = {}) {
  let calls = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      calls++;
      const { id, params } = JSON.parse(body) as {
        id: number;
        params: {
          filter: {
            from_block: { block_number: number };
            to_block: { block_number: number };
            chunk_size: number;
            continuation_token?: string;
          };
        };
      };
      await new Promise((r) => setTimeout(r, o.delayMs ?? 0));
      res.setHeader("content-type", "application/json");
      if (o.fail !== undefined) {
        res.end(JSON.stringify({ jsonrpc: "2.0", id, error: o.fail }));
        return;
      }
      const f = params.filter;
      let [block, skip] = (f.continuation_token ?? `${f.from_block.block_number}-0`)
        .split("-")
        .map(Number) as [number, number];
      const end = Math.min(f.to_block.block_number, block + 255);
      const out: EmittedEvent[] = [];
      for (const e of events) {
        if (e.block_number! < block || e.block_number! > end) continue;
        if (e.block_number === block && skip > 0) {
          skip--;
          continue;
        }
        out.push(e);
        if (out.length === f.chunk_size) break;
      }
      const last = out.at(-1);
      const token =
        out.length === f.chunk_size && last !== undefined
          ? `${last.block_number}-${out.filter((e) => e.block_number === last.block_number).length}`
          : end < f.to_block.block_number
            ? `${end + 1}-0`
            : undefined;
      const result =
        token === undefined ? { events: out } : { events: out, continuation_token: token };
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls: () => calls };
}

async function host(nodeUrl: string) {
  pool ??= new pg.Pool({ connectionString: url, max: 2 });
  await pool.query(`DROP SCHEMA IF EXISTS kasbah_cache_${CHAIN} CASCADE`);
  const cache = await EventCache.open(pool, CHAIN);
  const rpc = new RpcClient([{ url: nodeUrl, maxRequestsPerSecond: 400 }]);
  return { rpc, status: new Status(), cache, database: url! };
}

const job = { addresses: ["0xa"], keys: [["0x51"]], from: 0, to: BLOCKS - 1, chunkSize: 16 };
const id = (e: EmittedEvent) => `${e.block_number}:${e.transaction_index}:${e.event_index}`;

test.skipIf(url === undefined)(
  "the fetch thread fills the cache, yields how far it has every block, and its calls count on the main client",
  async () => {
    const n = await node();
    const h = await host(n.url);
    const { endpoints, rate } = h.status;
    let through = -1;
    for await (const batch of fetchThread(h, {
      ...job,
      ranges: [[0, BLOCKS - 1]],
      concurrency: 4,
    })) {
      expect(batch.events).toEqual([]);
      expect(batch.through).toBeGreaterThan(through);
      through = batch.through;
    }
    expect(through).toBe(BLOCKS - 1);
    const read: EmittedEvent[] = [];
    for await (const b of h.cache.read(["0xa"], ["0x51"], 0, BLOCKS - 1)) read.push(...b.events);
    expect(read.map(id)).toEqual(events.map(id));
    expect(await h.cache.missing(["0xa"], ["0x51"], 0, BLOCKS - 1)).toEqual([]);
    expect(h.rpc.stats.methods.starknet_getEvents).toBe(n.calls());
    expect(h.rpc.stats.calls).toBe(n.calls());
    expect(h.cache.stats.fetchedEvents).toBe(events.length);
    // What it lent comes back: half of the whole ceiling, 400.
    expect(h.rpc.lend(1 / 2).endpoints[0]!.maxRequestsPerSecond).toBe(200);
    expect(h.status.endpoints).toBe(endpoints);
    expect(h.status.rate).toBe(rate);
    expect(h.status.fetcher).toBeUndefined();
  },
);

test.skipIf(url === undefined)(
  "an error the thread can't retry fails the stream on the main thread, with the node's message",
  async () => {
    const n = await node({ fail: { code: -32602, message: "no such filter here" } });
    const h = await host(n.url);
    const run = async () => {
      for await (const _ of fetchThread(h, {
        ...job,
        ranges: [[0, BLOCKS - 1]],
        concurrency: 2,
      }));
    };
    await expect(run()).rejects.toThrow("no such filter here");
    expect(await h.cache.missing(["0xa"], ["0x51"], 0, BLOCKS - 1)).toEqual([[0, BLOCKS - 1]]);
  },
);

test.skipIf(url === undefined)(
  "a reader that stops early ends the thread at once and gets the rate back",
  async () => {
    const n = await node({ delayMs: 20 });
    const h = await host(n.url);
    const started = performance.now();
    for await (const batch of fetchThread(h, {
      ...job,
      ranges: [[0, BLOCKS - 1]],
      concurrency: 1,
    })) {
      expect(batch.through).toBeLessThan(BLOCKS - 1);
      break;
    }
    expect(performance.now() - started).toBeLessThan(5_000);
    const calls = n.calls();
    await new Promise((r) => setTimeout(r, 200));
    expect(n.calls()).toBeLessThanOrEqual(calls + 1);
    expect(h.rpc.lend(1).endpoints[0]!.maxRequestsPerSecond).toBe(400);
  },
);

test.skipIf(url === undefined)(
  "a stopped run ends the thread at once, and its stream ends with what was written, without an error",
  async () => {
    const n = await node({ delayMs: 50 });
    const h = await host(n.url);
    const stop = new AbortController();
    let last = -1;
    const started = performance.now();
    for await (const batch of fetchThread(
      { ...h, signal: stop.signal },
      { ...job, ranges: [[0, BLOCKS - 1]], concurrency: 1 },
    )) {
      last = batch.through;
      stop.abort();
    }
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(last).toBeLessThan(BLOCKS - 1);
    const calls = n.calls();
    await new Promise((r) => setTimeout(r, 300));
    expect(n.calls()).toBeLessThanOrEqual(calls + 1);
  },
);
