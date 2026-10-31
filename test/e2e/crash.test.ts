import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { counterAbi, counterNode } from "../fixtures/counter.ts";

const url = process.env.DATABASE_URL;
const schema = "kasbah_test_crash";
const BLOCKS = 300_000;
/** The last block that can't be reorged: the fake node's head less 64. */
const TO = BLOCKS - 1 - 64;
const node = counterNode(BLOCKS);
const dir = mkdtempSync(join(resolve("test"), ".tmp-crash-"));
const appFile = join(dir, "app.ts");

beforeAll(async () => {
  await new Promise<void>((r) => node.listen(0, "127.0.0.1", r));
  const rpc = `http://127.0.0.1:${(node.address() as { port: number }).port}`;
  writeFileSync(
    appFile,
    `import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { bignum, kasbah } from ${JSON.stringify(pathToFileURL(resolve("src/index.ts")).href)};
const counted = pgTable("counted", { id: text().primaryKey(), block: integer().notNull(), amount: bignum().notNull() });
const app = kasbah({ rpc: ${JSON.stringify(rpc)}, database: process.env.DATABASE_URL!, schema: ${JSON.stringify(schema)}, api: false,
  contracts: { C: { abi: ${JSON.stringify(counterAbi)}, address: "0xc", startBlock: 0 } }, tables: { counted } });
app.on("C:Counted", async ({ event, context }) => {
  await context.db.insert(counted).values({ id: event.transaction.hash, block: event.block.number, amount: event.args.amount });
});
export default app;
`,
  );
});

afterAll(async () => {
  node.close();
  rmSync(dir, { recursive: true, force: true });
  if (url === undefined) return;
  const p = new pg.Pool({ connectionString: url, max: 1 });
  await p.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await p.end();
});

const start = (reset: boolean) =>
  spawn(
    process.execPath,
    [
      // Rows waiting for a commit pass a tenth of the heap often: many commits, each overlapping handlers.
      "--max-old-space-size=192",
      "--no-warnings",
      "src/cli/main.ts",
      "start",
      appFile,
      "--to",
      String(TO),
      "--no-ui",
      ...(reset ? ["--reset"] : []),
    ],
    { env: { ...process.env, DATABASE_URL: url } },
  );

test.skipIf(url === undefined)(
  "killed mid-backfill with a commit in flight, a restart ends with every row once",
  async () => {
    const db = new pg.Pool({ connectionString: url, max: 1 });
    try {
      const checkpoint = async () => {
        try {
          const { rows } = await db.query(
            `SELECT value FROM ${schema}._kasbah_meta WHERE key = 'checkpoint'`,
          );
          return rows.length === 0 ? -1 : Number(rows[0].value);
        } catch {
          return -1;
        }
      };
      const first = start(true);
      const log: string[] = [];
      first.stdout.on("data", (d) => log.push(String(d)));
      first.stderr.on("data", (d) => log.push(String(d)));
      let killedAt = -1;
      for (let i = 0; i < 600 && killedAt < 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const c = await checkpoint();
        if (c > 0 && c < TO) killedAt = c;
      }
      if (first.exitCode === null && first.signalCode === null) {
        first.kill("SIGKILL");
        await new Promise((r) => first.once("exit", r));
      }
      expect(killedAt, log.join("")).toBeGreaterThan(0);

      const out: string[] = [];
      const second = start(false);
      second.stdout.on("data", (d) => out.push(String(d)));
      second.stderr.on("data", (d) => out.push(String(d)));
      const code = await new Promise((r) => second.once("exit", r));
      expect(out.join(""), out.join("")).not.toMatch(/already exists|duplicate/);
      expect(code).toBe(0);
      const to = TO;
      const { rows } = await db.query(
        `SELECT count(*)::int AS n, count(DISTINCT id)::int AS ids, min(block) AS lo, max(block) AS hi,
                sum(block)::text AS blocks, sum(amount - block)::text AS extra FROM ${schema}.counted`,
      );
      // The fake node's block n: one event, amount n + 1.
      expect(rows[0]).toEqual({
        n: to + 1,
        ids: to + 1,
        lo: 0,
        hi: to,
        blocks: String((to * (to + 1)) / 2),
        extra: String(to + 1),
      });
    } finally {
      await db.end();
    }
  },
  300_000,
);
