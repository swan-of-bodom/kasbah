import { createServer } from "node:http";
import { pgTable, text } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { bignum, kasbah } from "../../src/index.ts";
import { Status } from "../../src/indexer/status.ts";
import { counterAbi, counterNode } from "../fixtures/counter.ts";

const url = process.env.DATABASE_URL;
const schema = "kasbah_test_contracts";
const BLOCKS = 40;
const DEPLOYED = 13;
const totals = pgTable("totals", { id: text().primaryKey(), total: bignum().notNull() });
const node = counterNode(BLOCKS, DEPLOYED);
/** Two addresses taking turns, behind a proxy recording each `getEvents` filter. */
const pair = counterNode(BLOCKS, 0, ["0xc", "0xe"]);
const asked: { address?: string[]; to_block: { block_number: number } }[] = [];
const proxy = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    for (const c of [JSON.parse(body)].flat())
      if (c.method === "starknet_getEvents") asked.push(c.params.filter);
    const out = await (await fetch(pairUrl, { method: "POST", body })).text();
    res.writeHead(200, { "content-type": "application/json" }).end(out);
  });
});
let rpc: string;
let pairUrl: string;
let proxied: string;

const listen = async (s: ReturnType<typeof createServer>) => {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
};

beforeAll(async () => {
  [rpc, pairUrl, proxied] = (await Promise.all([node, pair, proxy].map(listen))) as [
    string,
    string,
    string,
  ];
});
afterAll(async () => {
  for (const s of [node, pair, proxy]) s.close();
  if (url === undefined) return;
  const p = new pg.Pool({ connectionString: url, max: 1 });
  await p.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await p.end();
});

const app = (
  c: { address: string | string[]; startBlock: number | "deployment"; endBlock?: number },
  at = rpc,
) => {
  const a = kasbah({
    rpc: at,
    database: url,
    schema,
    contracts: { C: { abi: counterAbi, ...c } },
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

test.skipIf(url === undefined)(
  'startBlock "deployment": indexes from the block it was deployed in',
  async () => {
    const status = new Status();
    const notes: string[] = [];
    status.subscribe((n) => notes.push(n.text));
    await app({ address: "0xc", startBlock: "deployment" }).run({
      reset: true,
      to: BLOCKS - 5,
      status,
    });
    expect(notes).toContain(`C was deployed in block ${DEPLOYED}: indexing from there`);
    const p = new pg.Pool({ connectionString: url, max: 1 });
    try {
      const r = await p.query(`SELECT total::text FROM ${schema}.totals`);
      // Block n counts n + 1: blocks DEPLOYED..35.
      let sum = 0;
      for (let n = DEPLOYED; n <= BLOCKS - 5; n++) sum += n + 1;
      expect(r.rows[0].total).toBe(String(sum));
    } finally {
      await p.end();
    }
  },
);

test.skipIf(url === undefined)(
  "address: [a, b] with endBlock: both indexed, nothing fetched after it",
  async () => {
    const END = 20;
    await app({ address: ["0xc", "0xe"], startBlock: 0, endBlock: END }, proxied).run({
      reset: true,
      to: BLOCKS - 5,
    });
    const p = new pg.Pool({ connectionString: url, max: 1 });
    try {
      const r = await p.query(`SELECT total::text FROM ${schema}.totals`);
      expect(r.rows[0].total).toBe(String(((END + 1) * (END + 2)) / 2));
    } finally {
      await p.end();
    }
    // The watched addresses' requests; the startup probe asks for one address, not a list.
    const fetched = asked.filter((f) => Array.isArray(f.address) && f.address.length > 0);
    expect(fetched.length).toBeGreaterThan(0);
    for (const f of fetched) {
      expect(f.to_block.block_number).toBeLessThanOrEqual(END);
      expect(f.address!.map(BigInt).sort()).toEqual([0xcn, 0xen]);
    }
  },
);
