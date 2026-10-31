import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { selector } from "../../src/abi/selector.ts";
import { header } from "../fixtures/header.ts";

const url = process.env.DATABASE_URL;
const schema = "kasbah_test_memory";
const BLOCKS = 300_000;
const FELTS = 30;
const HEAP_MB = 256;

const abi = [
  {
    type: "event",
    name: "m::Big",
    kind: "struct",
    members: Array.from({ length: FELTS }, (_, i) => ({
      name: `v${i}`,
      type: "core::felt252",
      kind: "data",
    })),
  },
  {
    type: "event",
    name: "m::Event",
    kind: "enum",
    variants: [{ name: "Big", type: "m::Big", kind: "nested" }],
  },
] as const;

const hash = (n: number) => `0x${(n + 1).toString(16)}bb`;
/** Full-width felts, different in every block, so each event costs what a real one does. */
const felt = (n: number, i: number) =>
  `0x${((BigInt(n) * 7919n + BigInt(i)) * 0x9e3779b97f4a7c15n).toString(16).slice(0, 62)}`;
const event = (n: number) => ({
  from_address: "0xb",
  keys: [selector("Big")],
  data: Array.from({ length: FELTS }, (_, i) => felt(n, i)),
  block_number: n,
  block_hash: hash(n),
  transaction_hash: `0x${n.toString(16)}`,
  transaction_index: 0,
  event_index: 0,
});

/** One event per block, paged by `chunk_size` like Pathfinder; events are built per request, not held. */
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body);
    const answer = ({ id, method, params }: { id: number; method: string; params: any }) => {
      const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
      switch (method) {
        case "starknet_specVersion":
          return ok("0.10.4");
        case "starknet_chainId":
          return ok("0xbeef");
        case "pathfinder_version":
          return ok("fake");
        case "starknet_blockNumber":
          return ok(BLOCKS - 1);
        case "starknet_blockHashAndNumber":
          return ok({ block_hash: hash(BLOCKS - 1), block_number: BLOCKS - 1 });
        case "starknet_getBlockWithTxHashes": {
          const n = params.block_id === "l1_accepted" ? 0 : params.block_id.block_number;
          return ok(
            header({
              block_hash: hash(n),
              parent_hash: n === 0 ? "0x0" : hash(n - 1),
              block_number: n,
              timestamp: 1_000 + n,
            }),
          );
        }
        case "starknet_getClassHashAt":
          return ok("0xcb");
        case "starknet_getClass":
          return ok({ abi: JSON.stringify(abi) });
        case "starknet_getEvents": {
          const f = params.filter;
          if (f.chunk_size > 1024)
            return {
              jsonrpc: "2.0",
              id,
              error: { code: 31, message: "Requested page size is too big" },
            };
          const from =
            f.continuation_token === undefined
              ? f.from_block.block_number
              : Number(f.continuation_token.split("-")[0]);
          const to = Math.min(f.to_block.block_number, BLOCKS - 1);
          const end = Math.min(to, from + f.chunk_size - 1);
          const events = [];
          for (let n = from; n <= end; n++) events.push(event(n));
          return ok(end < to ? { events, continuation_token: `${end + 1}-0` } : { events });
        }
      }
      return { jsonrpc: "2.0", id, error: { code: -32601, message: method } };
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(answer) : answer(parsed)));
  });
});

const dir = mkdtempSync(join(resolve("test"), ".tmp-memory-"));
const appFile = join(dir, "app.ts");
const index = pathToFileURL(resolve("src/index.ts")).href;

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const rpc = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  writeFileSync(
    appFile,
    `import { integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { kasbah } from ${JSON.stringify(index)};
const big = pgTable("big", { id: text().primaryKey(), block: integer().notNull(), values: jsonb().notNull() });
const abi = ${JSON.stringify(abi)} as const;
const app = kasbah({ rpc: ${JSON.stringify(rpc)}, database: process.env.DATABASE_URL!, schema: ${JSON.stringify(schema)},
  contracts: { M: { abi, address: "0xb", startBlock: 0 } }, tables: { big }, reorgWindow: 4 });
app.on("M:Big", async ({ event, context }) => {
  await context.db.insert(big).values({ id: event.transaction.hash, block: event.block.number, values: Object.values(event.args).map(String) });
});
export default app;
`,
  );
});

afterAll(async () => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
  if (url === undefined) return;
  const p = new pg.Pool({ connectionString: url, max: 1 });
  await p.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await p.end();
});

test.skipIf(url === undefined)(
  `a backfill of large events fits a ${HEAP_MB} MB heap: the fetch buffer and the row cache follow the heap`,
  async () => {
    const to = BLOCKS - 5;
    const out: string[] = [];
    const p = spawn(
      process.execPath,
      [
        `--max-old-space-size=${HEAP_MB}`,
        "--no-warnings",
        "src/cli/main.ts",
        "start",
        appFile,
        "--to",
        String(to),
        "--reset",
        "--no-ui",
      ],
      { env: { ...process.env, DATABASE_URL: url } },
    );
    p.stdout.on("data", (d) => out.push(String(d)));
    p.stderr.on("data", (d) => out.push(String(d)));
    const code = await new Promise<number | null>((r) => p.once("exit", r));
    expect(out.join("")).not.toMatch(/heap out of memory/);
    expect(code).toBe(0);
    const db = new pg.Pool({ connectionString: url, max: 1 });
    const { rows } = await db.query(
      `SELECT count(*)::int AS n, max(block) AS last FROM ${schema}.big`,
    );
    await db.end();
    expect(rows[0]).toEqual({ n: to + 1, last: to });
  },
  300_000,
);
