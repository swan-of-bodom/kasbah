import { pgTable, text } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { bignum, kasbah } from "../../src/index.ts";
import { Status } from "../../src/indexer/status.ts";
import { counterAbi, counterNode } from "../fixtures/counter.ts";

const url = process.env.DATABASE_URL;
const schema = "kasbah_test_deployment";
const BLOCKS = 40;
const DEPLOYED = 13;
const totals = pgTable("totals", { id: text().primaryKey(), total: bignum().notNull() });
const node = counterNode(BLOCKS, DEPLOYED);
let rpc: string;

beforeAll(async () => {
  await new Promise<void>((r) => node.listen(0, "127.0.0.1", r));
  rpc = `http://127.0.0.1:${(node.address() as { port: number }).port}`;
});
afterAll(async () => {
  node.close();
  if (url === undefined) return;
  const p = new pg.Pool({ connectionString: url, max: 1 });
  await p.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await p.end();
});

const app = (address: string) => {
  const a = kasbah({
    rpc,
    database: url,
    schema,
    contracts: { C: { abi: counterAbi, address, startBlock: "deployment" } },
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
    await app("0xc").run({ reset: true, to: BLOCKS - 5, status });
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
