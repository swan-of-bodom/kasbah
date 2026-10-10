import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { counterAbi, counterNode } from "./fixtures/counter.ts";

const url = process.env.DATABASE_URL;
const root = join(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "kasbah-pkg-"));
const node = counterNode(100);
let rpcUrl = "";
beforeAll(async () => {
  await new Promise<void>((r) => node.listen(0, "127.0.0.1", r));
  rpcUrl = `http://127.0.0.1:${(node.address() as { port: number }).port}`;
});
afterAll(async () => {
  node.close();
  rmSync(dir, { recursive: true, force: true });
  if (url === undefined) return;
  const p = new pg.Pool({ connectionString: url, max: 1 });
  await p.query(`DROP SCHEMA IF EXISTS kasbah_test_pkg CASCADE`);
  await p.query(`DROP SCHEMA IF EXISTS kasbah_test_init CASCADE`);
  await p.query(`DROP SCHEMA IF EXISTS kasbah_cache_0xc0c0 CASCADE`);
  await p.end();
});

test("the packed package installs and works outside the repo: library, types and the kasbah command", () => {
  const pnpm = (args: string[], cwd: string) => execFileSync("pnpm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  pnpm(["pack", "--pack-destination", dir], root);
  const tarball = readdirSync(dir).find((f) => f.endsWith(".tgz"))!;
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module", dependencies: { kasbah: `file:./${tarball}`, "drizzle-orm": "^0.45.4" } }));
  // The repo's store: pnpm keeps one per filesystem, and the temp dir may be on another (tmpfs).
  pnpm(["install", "--offline", "--store-dir", pnpm(["store", "path"], root).trim()], dir);

  // Plain JavaScript inside node_modules: no type stripping needed.
  const imported = execFileSync(process.execPath, ["--input-type=module", "-e", `const m = await import("kasbah"); console.log(typeof m.kasbah, typeof m.bignum, typeof m.Status)`], { cwd: dir, encoding: "utf8" });
  expect(imported.trim()).toBe("function function function");
  expect(readdirSync(join(dir, "node_modules/kasbah/dist"))).toContain("index.d.ts");
  // Source maps and declaration maps point at the shipped sources: stack traces and go-to-definition land in .ts.
  const map = JSON.parse(readFileSync(join(dir, "node_modules/kasbah/dist/run.js.map"), "utf8")) as { sources: string[] };
  expect(existsSync(join(dir, "node_modules/kasbah/dist", map.sources[0]!))).toBe(true);
  expect(readdirSync(join(dir, "node_modules/kasbah/dist"))).toContain("index.d.ts.map");
  expect(execFileSync(join(dir, "node_modules/.bin/kasbah"), ["--help"], { cwd: dir, encoding: "utf8" })).toContain("kasbah start <app.ts>");
}, 120_000);

test.skipIf(url === undefined)("the installed kasbah command runs a TypeScript app, with DATABASE_URL from .env", async () => {
  writeFileSync(join(dir, ".env"), `DATABASE_URL=${url}\n`);
  writeFileSync(join(dir, "app.ts"), `import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { bignum, kasbah } from "kasbah";
const totals = pgTable("totals", { id: text().primaryKey(), total: bignum().notNull(), n: integer().notNull() });
const abi = ${JSON.stringify(counterAbi)} as const;
const app = kasbah({ rpc: ${JSON.stringify(rpcUrl)}, database: process.env.DATABASE_URL!, schema: "kasbah_test_pkg",
  contracts: { C: { abi, address: "0xc", startBlock: 0 } }, tables: { totals }, reorgWindow: 4 });
app.on("C:Counted", async ({ event, context }) => {
  const v = event.args.amount;
  await context.db.insert(totals).values({ id: "all", total: v, n: 1 }).onConflictDoUpdate((r) => ({ total: r.total + v, n: r.n + 1 }));
});
export default app;
`);
  const { DATABASE_URL: _, ...env } = process.env;
  const { stdout, stderr } = await promisify(execFile)(join(dir, "node_modules/.bin/kasbah"), ["start", "app.ts", "--to", "15", "--reset"], { cwd: dir, env, encoding: "utf8" });
  expect(stdout).toMatch(/backfill done: 16 handled/);
  // Node's type-stripping warning is expected and hidden.
  expect(stderr).toBe("");
  const p = new pg.Pool({ connectionString: url, max: 1 });
  const total = (await p.query(`SELECT total::text FROM kasbah_test_pkg.totals`)).rows[0].total;
  await p.end();
  expect(total).toBe(String((16 * 17) / 2));
}, 60_000);

test.skipIf(url === undefined)("kasbah init writes a project that installs, typechecks and indexes", async () => {
  const tarball = readdirSync(dir).find((f) => f.endsWith(".tgz"))!;
  const bin = join(dir, "node_modules/.bin/kasbah");
  const run = promisify(execFile);
  // Without a terminal every answer is a flag; the deployment block is found on the chain.
  const { stdout } = await run(bin, ["init", "kasbah_test_init", "--rpc", rpcUrl, "--address", "0xc", "--name", "C", "--database", url!, "--timestamps", "--kasbah", `file:../${tarball}`], { cwd: dir, encoding: "utf8" });
  expect(stdout).toMatch(/Finding its deployment block {2}block 0/);
  const project = join(dir, "kasbah_test_init");
  expect(readFileSync(join(project, "schema.ts"), "utf8")).toContain(`export const counted = pgTable("counted", {`);
  const pnpm = (args: string[]) => execFileSync("pnpm", args, { cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  pnpm(["install", "--offline", "--store-dir", execFileSync("pnpm", ["store", "path"], { cwd: root, encoding: "utf8" }).trim()]);
  pnpm(["typecheck"]);
  // Only the project's .env: variables already set would win over it.
  const { DATABASE_URL: _, KASBAH_RPC_URL: __, ...env } = process.env;
  const started = await run(join(project, "node_modules/.bin/kasbah"), ["start", "app.ts", "--to", "15", "--reset"], { cwd: project, env, encoding: "utf8" });
  expect(started.stdout).toMatch(/backfill done: 16 handled/);
  const p = new pg.Pool({ connectionString: url, max: 1 });
  const rows = (await p.query(`SELECT block, timestamp, amount::text FROM kasbah_test_init.counted ORDER BY block`)).rows;
  await p.end();
  // The fake node's block n: timestamp 1000 + n, amount n + 1.
  expect(rows).toEqual(Array.from({ length: 16 }, (_, n) => ({ block: n, timestamp: 1_000 + n, amount: String(n + 1) })));
}, 120_000);
