import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { selector } from "../src/abi/selector.ts";

const url = process.env.DATABASE_URL;
const schema = "kasbah_test_cli";
const BLOCKS = 40;
const abi = [
  { type: "event", name: "c::Counted", kind: "struct", members: [{ name: "amount", type: "core::integer::u128", kind: "data" }] },
  { type: "event", name: "c::Event", kind: "enum", variants: [{ name: "Counted", type: "c::Counted", kind: "nested" }] },
];
const hash = (n: number) => `0x${(n + 1).toString(16)}aa`;
const events = Array.from({ length: BLOCKS }, (_, n) => ({
  from_address: "0xc", keys: [selector("Counted")], data: [`0x${(n + 1).toString(16)}`], block_number: n, block_hash: hash(n), transaction_hash: `0x${n}`, transaction_index: 0, event_index: 0,
}));

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body);
    const answer = ({ id, method, params }: { id: number; method: string; params: any }) => {
      const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
      switch (method) {
        case "starknet_specVersion": return ok("0.10.4");
        case "pathfinder_version": return ok("fake");
        case "starknet_blockNumber": return ok(BLOCKS - 1);
        case "starknet_blockHashAndNumber": return ok({ block_hash: hash(BLOCKS - 1), block_number: BLOCKS - 1 });
        case "starknet_getBlockWithTxHashes": {
          const n = params.block_id.block_number;
          if (n >= BLOCKS) return { jsonrpc: "2.0", id, error: { code: 24, message: "Block not found" } };
          return ok({ block_hash: hash(n), parent_hash: n === 0 ? "0x0" : hash(n - 1), block_number: n, timestamp: 1_000 + n, status: "ACCEPTED_ON_L2", transactions: [] });
        }
        case "starknet_getClassHashAt": return ok("0xca");
        case "starknet_getClass": return ok({ abi: JSON.stringify(abi) });
        case "starknet_getEvents": {
          const f = params.filter;
          return ok({ events: events.filter((e) => e.block_number >= f.from_block.block_number && e.block_number <= f.to_block.block_number) });
        }
      }
      return { jsonrpc: "2.0", id, error: { code: -32601, message: method } };
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(answer) : answer(parsed)));
  });
});
let rpcUrl: string;
// Inside the repo, so the app resolves drizzle-orm like a real one would.
const dir = mkdtempSync(join(resolve("test"), ".tmp-cli-"));
const appFile = join(dir, "app.ts");
const index = pathToFileURL(resolve("src/index.ts")).href;

const appSource = (factor: number) => `import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { bignum, kasbah } from ${JSON.stringify(index)};
const totals = pgTable("totals", { id: text().primaryKey(), total: bignum().notNull(), n: integer().notNull() });
const abi = ${JSON.stringify(abi)} as const;
const app = kasbah({ rpc: ${JSON.stringify("RPC")}, database: process.env.DATABASE_URL!, schema: ${JSON.stringify(schema)},
  contracts: { C: { abi, address: "0xc", startBlock: 0 } }, tables: { totals }, pollMs: 50, reorgWindow: 4 });
app.on("C:Counted", async ({ event, context }) => {
  const v = event.args.amount * ${factor}n;
  await context.db.insert(totals).values({ id: "all", total: v, n: 1 }).onConflictDoUpdate((r) => ({ total: r.total + v, n: r.n + 1 }));
});
export default app;
`;

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  rpcUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
  if (url === undefined) return;
  const p = new pg.Pool({ connectionString: url, max: 1 });
  await p.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await p.end();
});

const total = async () => {
  const p = new pg.Pool({ connectionString: url, max: 1 });
  try {
    return (await p.query(`SELECT total::text FROM ${schema}.totals WHERE id = 'all'`)).rows[0]?.total as string | undefined;
  } catch {
    return undefined;
  } finally {
    await p.end();
  }
};
const until = async (c: () => Promise<boolean>, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!(await c())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};
const sum = (BLOCKS * (BLOCKS + 1)) / 2;
const cli = (...args: string[]) => {
  const out: string[] = [];
  const p = spawn(process.execPath, ["--no-warnings", "src/cli.ts", ...args], { env: { ...process.env, DATABASE_URL: url } });
  p.stdout.on("data", (d) => out.push(String(d)));
  p.stderr.on("data", (d) => out.push(String(d)));
  return { p, out, exited: new Promise<number | null>((r) => p.once("exit", r)) };
};

test.skipIf(url === undefined)("start --to indexes final blocks and exits; a changed build is refused", async () => {
  writeFileSync(appFile, appSource(1).replace('"RPC"', JSON.stringify(rpcUrl)));
  const run = cli("start", appFile, "--to", String(BLOCKS - 1), "--reset");
  expect(await run.exited).toBe(0);
  // The head is block 39 and 4 blocks can still be reorged: indexed through 35 (amounts 1..36).
  expect(await total()).toBe(String((36 * 37) / 2));
  expect(run.out.join("")).toMatch(/--to 39 is past block 35, the last one that can't be reorged/);

  writeFileSync(appFile, appSource(2).replace('"RPC"', JSON.stringify(rpcUrl)));
  const refused = cli("start", appFile, "--to", String(BLOCKS - 1));
  expect(await refused.exited).toBe(1);
  expect(refused.out.join("")).toMatch(/holds another build/);
}, 60_000);

test.skipIf(url === undefined)("dev: restarts on a change and re-indexes a changed build", async () => {
  writeFileSync(appFile, appSource(3).replace('"RPC"', JSON.stringify(rpcUrl)));
  const run = cli("dev", appFile);
  try {
    await until(async () => (await total()) === String(3 * sum)).catch((e) => {
      console.log(run.out.join(""));
      throw e;
    });
    writeFileSync(appFile, appSource(5).replace('"RPC"', JSON.stringify(rpcUrl)));
    await until(async () => (await total()) === String(5 * sum));
    expect(run.out.join("")).toMatch(/change detected, restarting/);
    expect(run.out.join("")).toMatch(/build changed/);
  } finally {
    run.p.kill("SIGINT");
  }
  expect(await run.exited).toBe(0);
}, 60_000);

test.skipIf(url === undefined)("cache info runs", async () => {
  const run = cli("cache", "info", "--chain", "0x0");
  expect(await run.exited).toBe(0);
});
