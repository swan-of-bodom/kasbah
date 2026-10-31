import { integer, pgTable, text } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { kasbah } from "../../src/index.ts";
import { counterAbi, counterNode } from "../fixtures/counter.ts";

const url = process.env.DATABASE_URL;
const schema = "kasbah_test_loop";
const BLOCKS = 60_000;
const node = counterNode(BLOCKS);
let rpc = "";

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

const counted = pgTable("counted", { id: text().primaryKey(), block: integer().notNull() });

test.skipIf(url === undefined)(
  "a backfill gives the event loop a turn every few ms, even when handlers never wait",
  async () => {
    const app = kasbah({
      rpc,
      database: url!,
      schema,
      api: false,
      contracts: { C: { abi: counterAbi, address: "0xc", startBlock: 0 } },
      tables: { counted },
    });
    app.on("C:Counted", async ({ event, context }) => {
      await context.db
        .insert(counted)
        .values({ id: event.transaction.hash, block: event.block.number });
      // Work a real handler might do, without I/O.
      let x = 0;
      for (let i = 0; i < 2_000; i++) x += Math.sqrt(i);
      if (x < 0) throw new Error();
    });
    let last = performance.now();
    let worst = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 10);
    try {
      await app.run({ to: BLOCKS - 5, reset: true });
    } finally {
      clearInterval(timer);
    }
    // Without the turns: about 1 s. The commit still holds it ~250 ms.
    expect(worst).toBeLessThan(500);
  },
  120_000,
);
