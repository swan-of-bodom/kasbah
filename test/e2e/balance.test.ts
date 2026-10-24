import { createServer, type Server } from "node:http";
import { pgTable, text } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { bignum, kasbah, loadBalance } from "../../src/index.ts";
import { Status } from "../../src/indexer/status.ts";
import { counterAbi, counterNode } from "../fixtures/counter.ts";

const url = process.env.DATABASE_URL;
const schema = "kasbah_test_balance";
const BLOCKS = 30;
const totals = pgTable("totals", { id: text().primaryKey(), total: bignum().notNull() });

const listen = async (s: Server) => {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
};
const nodes = [counterNode(BLOCKS), counterNode(BLOCKS)];
let urls: string[];
/** The first node, except that it says it's on mainnet. */
let mainnet: { server: Server; url: string };

beforeAll(async () => {
  urls = await Promise.all(nodes.map(listen));
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const call = JSON.parse(body);
      const out =
        !Array.isArray(call) && call.method === "starknet_chainId"
          ? JSON.stringify({ jsonrpc: "2.0", id: call.id, result: "0x534e5f4d41494e" })
          : await (await fetch(urls[0]!, { method: "POST", body })).text();
      res.writeHead(200, { "content-type": "application/json" }).end(out);
    });
  });
  mainnet = { server, url: await listen(server) };
});
afterAll(async () => {
  for (const s of [...nodes, mainnet.server]) s.close();
  if (url === undefined) return;
  const p = new pg.Pool({ connectionString: url, max: 1 });
  await p.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await p.end();
});

const app = (rpc: Parameters<typeof kasbah>[0]["rpc"]) => {
  const a = kasbah({
    rpc,
    database: url,
    schema,
    contracts: { C: { abi: counterAbi, address: "0xc", startBlock: 0 } },
    tables: { totals },
    reorgWindow: 4,
  });
  a.on("C:Counted", async ({ event, context }) => {
    const v = event.args.amount;
    await context.db
      .insert(totals)
      .values({ id: "all", total: v })
      .onConflictDoUpdate((r) => ({ total: r.total + v }));
  });
  return a;
};

test.skipIf(url === undefined)("loadBalance: one run over two nodes, both used", async () => {
  const status = new Status();
  await app(loadBalance([urls[0]!, { url: urls[1]!, maxRequestsPerSecond: 50 }])).run({
    reset: true,
    to: BLOCKS - 5,
    status,
  });
  const p = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const r = await p.query(`SELECT total::text FROM ${schema}.totals`);
    expect(r.rows[0].total).toBe(String(((BLOCKS - 4) * (BLOCKS - 3)) / 2));
  } finally {
    await p.end();
  }
  const endpoints = status.endpoints();
  expect(endpoints).toHaveLength(2);
  for (const e of endpoints) expect(e.calls).toBeGreaterThan(0);
});

test.skipIf(url === undefined)("loadBalance: nodes on different chains are refused", async () => {
  await expect(app([urls[1]!, mainnet.url]).run({ to: BLOCKS - 5 })).rejects.toThrow(
    /the endpoints are on different chains \(127\.0\.0\.1:\d+: 0xc0c0, 127\.0\.0\.1:\d+: mainnet\)/,
  );
});
