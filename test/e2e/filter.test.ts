import { integer, pgTable, text } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { rawSelector } from "../../src/abi/selector.ts";
import { kasbah } from "../../src/index.ts";
import { keyedAbi, keyedNode } from "../fixtures/keyed.ts";

const url = process.env.DATABASE_URL;
const schema = "kasbah_test_filter";
const BLOCKS = 30;
const seen = pgTable("seen", {
  id: text().primaryKey(),
  name: text().notNull(),
  block: integer().notNull(),
  at: integer().notNull(),
});
const node = keyedNode(BLOCKS);
let rpc: string;

beforeAll(async () => {
  await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
  rpc = `http://127.0.0.1:${(node.server.address() as { port: number }).port}`;
});
afterAll(async () => {
  node.server.close();
  if (url === undefined) return;
  const p = new pg.Pool({ connectionString: url, max: 1 });
  await p.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await p.end();
});

test.skipIf(url === undefined)(
  "filter: a key argument fetched by its own stream, merged in chain order with the rest",
  async () => {
    let at = 0;
    const app = kasbah({
      cache: false,
      rpc,
      database: url,
      schema,
      contracts: {
        K: {
          abi: keyedAbi,
          address: "0xd",
          startBlock: 0,
          upgradeEvents: [],
          filter: { Moved: { who: "0x2" } },
        },
      },
      tables: { seen },
      reorgWindow: 4,
    });
    app.on("K:Moved", async ({ event, context }) => {
      await context.db.insert(seen).values({
        id: `m${event.block.number}`,
        name: "Moved",
        block: event.block.number,
        at: at++,
      });
    });
    app.on("K:Pinged", async ({ event, context }) => {
      await context.db.insert(seen).values({
        id: `p${event.block.number}`,
        name: "Pinged",
        block: event.block.number,
        at: at++,
      });
    });
    await app.run({ reset: true, to: BLOCKS - 1 });

    const p = new pg.Pool({ connectionString: url, max: 1 });
    try {
      const rows = (await p.query(`SELECT name, block FROM ${schema}.seen ORDER BY at`)).rows;
      const final = BLOCKS - 1 - 4;
      const moved = rows.filter((r) => r.name === "Moved").map((r) => r.block);
      expect(moved).toEqual(
        Array.from({ length: final + 1 }, (_, n) => n).filter((n) => n % 3 === 1),
      );
      expect(rows.filter((r) => r.name === "Pinged")).toHaveLength(final + 1);
      // Handled in chain order: in each block Moved (event 0) before Pinged (event 1).
      const order = rows.map((r) => r.block * 2 + (r.name === "Moved" ? 0 : 1));
      expect(order).toEqual([...order].sort((a, b) => a - b));
    } finally {
      await p.end();
    }
    // Without keys: the startup probe of the page size, which matches nothing.
    const asked = node.filters.flatMap((f) =>
      f.keys === undefined ? [] : [JSON.stringify(f.keys)],
    );
    expect(asked).toContain(JSON.stringify([[rawSelector("Moved")], ["0x2"]]));
    expect(asked).toContain(JSON.stringify([[rawSelector("Pinged")]]));
    expect(asked.some((k) => k.includes(rawSelector("Moved")) && !k.includes('"0x2"'))).toBe(false);
  },
);
