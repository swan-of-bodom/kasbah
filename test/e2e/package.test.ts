import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { counterAbi, counterNode } from "../fixtures/counter.ts";

const url = process.env.DATABASE_URL;
/** A git identity for init's first commit, which CI may not have. */
const GIT_USER = {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};
const root = join(import.meta.dirname, "../..");
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
  await p.end();
});

test("the packed package installs and works outside the repo: library, types and the kasbah command", () => {
  const pnpm = (args: string[], cwd: string) =>
    execFileSync("pnpm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  pnpm(["pack", "--pack-destination", dir], root);
  const tarball = readdirSync(dir).find((f) => f.endsWith(".tgz"))!;
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "consumer",
      private: true,
      type: "module",
      dependencies: { kasbah: `file:./${tarball}`, "drizzle-orm": "^0.45.4" },
    }),
  );
  // The repo's store: pnpm keeps one per filesystem, and the temp dir may be on another (tmpfs).
  pnpm(["install", "--prefer-offline", "--store-dir", pnpm(["store", "path"], root).trim()], dir);

  // Plain JavaScript inside node_modules: no type stripping needed.
  const imported = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const m = await import("kasbah"); console.log(typeof m.kasbah, typeof m.bignum, typeof m.Status)`,
    ],
    { cwd: dir, encoding: "utf8" },
  );
  expect(imported.trim()).toBe("function function function");
  expect(readdirSync(join(dir, "node_modules/kasbah/dist"))).toContain("index.d.ts");
  const map = JSON.parse(
    readFileSync(join(dir, "node_modules/kasbah/dist/indexer/run.js.map"), "utf8"),
  ) as { sources: string[] };
  expect(existsSync(join(dir, "node_modules/kasbah/dist/indexer", map.sources[0]!))).toBe(true);
  expect(readdirSync(join(dir, "node_modules/kasbah/dist"))).toContain("index.d.ts.map");
  expect(
    execFileSync(join(dir, "node_modules/.bin/kasbah"), ["--help"], {
      cwd: dir,
      encoding: "utf8",
    }),
  ).toContain("Usage: kasbah <command> [options]");
}, 120_000);

test("create-kasbah (what `pnpm create kasbah` runs) is init from the installed package", async () => {
  const pnpm = (args: string[], cwd: string) =>
    execFileSync("pnpm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const tarball = readdirSync(dir).find((f) => f.endsWith(".tgz"))!;
  const create = join(dir, "create");
  mkdirSync(create);
  pnpm(["pack", "--pack-destination", create], join(root, "create"));
  const createTarball = readdirSync(create).find((f) => f.endsWith(".tgz"))!;
  writeFileSync(
    join(create, "package.json"),
    JSON.stringify({
      name: "c",
      private: true,
      dependencies: { "create-kasbah": `file:./${createTarball}` },
    }),
  );
  // Its kasbah dependency comes from the tarball, not the registry. In pnpm-workspace.yaml: pnpm 11 and later
  // ignore `pnpm.overrides` in package.json, and this directory has no `packageManager` to pin an older one.
  writeFileSync(join(create, "pnpm-workspace.yaml"), `overrides:\n  kasbah: file:../${tarball}\n`);
  pnpm(
    ["install", "--prefer-offline", "--store-dir", pnpm(["store", "path"], root).trim()],
    create,
  );
  // Async: the fake node answering it runs in this process.
  const { stdout: out } = await promisify(execFile)(
    join(create, "node_modules/.bin/create-kasbah"),
    [
      "proj",
      "--rpc",
      rpcUrl,
      "--address",
      "0xc",
      "--name",
      "C",
      "--start",
      "0",
      "--database",
      "postgres://nobody@127.0.0.1:1/x",
      "--npm",
      "--skip-install",
    ],
    { cwd: create, encoding: "utf8", env: { ...process.env, ...GIT_USER } },
  );
  expect(out).toContain("kasbah init");
  const project = join(create, "proj");
  expect(JSON.parse(readFileSync(join(project, "package.json"), "utf8")).packageManager).toBe(
    undefined,
  );
  expect(out).toContain("npm run dev");
  const git = (args: string[]) => execFileSync("git", args, { cwd: project, encoding: "utf8" });
  expect(git(["rev-list", "--count", "HEAD"]).trim()).toBe("1");
  expect(git(["status", "--porcelain"])).toBe("");
  expect(git(["ls-files"]).split("\n")).not.toContain(".env");
  const help = execFileSync(join(create, "node_modules/.bin/create-kasbah"), ["--help"], {
    encoding: "utf8",
  });
  for (const option of ["--template", "--npm", "--skip-install", "--skip-git"])
    expect(help).toContain(option);
  expect(
    execFileSync(join(create, "node_modules/.bin/create-kasbah"), ["-v"], { encoding: "utf8" }),
  ).toBe(`${JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version}\n`);
  expect(
    JSON.parse(readFileSync(join(create, "proj/package.json"), "utf8")).dependencies.kasbah,
  ).toBe(`^${JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version}`);
  expect(readFileSync(join(create, "proj/src/index.ts"), "utf8")).toContain(`app.on("C:Counted"`);
  expect(readdirSync(join(create, "node_modules/create-kasbah"))).toContain("LICENSE");
}, 120_000);

test.skipIf(url === undefined)(
  "the installed kasbah command runs a TypeScript app, with DATABASE_URL from .env",
  async () => {
    writeFileSync(join(dir, ".env"), `DATABASE_URL=${url}\n`);
    writeFileSync(
      join(dir, "app.ts"),
      `import { integer, pgTable, text } from "drizzle-orm/pg-core";
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
`,
    );
    const { DATABASE_URL: _, ...env } = process.env;
    const { stdout, stderr } = await promisify(execFile)(
      join(dir, "node_modules/.bin/kasbah"),
      ["start", "app.ts", "--to", "15", "--reset"],
      { cwd: dir, env, encoding: "utf8" },
    );
    expect(stdout).toMatch(/backfill done: 16 handled/);
    expect(stderr).toBe("");
    const p = new pg.Pool({ connectionString: url, max: 1 });
    const total = (await p.query(`SELECT total::text FROM kasbah_test_pkg.totals`)).rows[0].total;
    await p.end();
    expect(total).toBe(String((16 * 17) / 2));
  },
  60_000,
);

test.skipIf(url === undefined)(
  "kasbah init writes a project that installs, typechecks and indexes",
  async () => {
    const tarball = readdirSync(dir).find((f) => f.endsWith(".tgz"))!;
    const bin = join(dir, "node_modules/.bin/kasbah");
    const run = promisify(execFile);
    const { stdout } = await run(
      bin,
      [
        "init",
        "kasbah_test_init",
        "--rpc",
        rpcUrl,
        "--address",
        "0xc",
        "--name",
        "C",
        "--database",
        url!,
        "--timestamps",
        "--no-ws",
        "--dependency",
        `file:../${tarball}`,
        "--skip-install",
        "--skip-git",
      ],
      { cwd: dir, encoding: "utf8" },
    );
    expect(stdout).toMatch(/Finding its deployment block {2}block 0/);
    const project = join(dir, "kasbah_test_init");
    expect(readFileSync(join(project, "kasbah.schema.ts"), "utf8")).toContain(
      `export const counted = pgTable("counted", {`,
    );
    expect(existsSync(join(project, "vendor"))).toBe(false);
    const pnpm = (args: string[]) =>
      execFileSync("pnpm", args, {
        cwd: project,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    pnpm([
      "install",
      "--prefer-offline",
      "--store-dir",
      execFileSync("pnpm", ["store", "path"], { cwd: root, encoding: "utf8" }).trim(),
    ]);
    pnpm(["typecheck"]);
    // Only the project's .env: variables already set would win over it.
    const { DATABASE_URL: _, KASBAH_RPC_URL: __, ...env } = process.env;
    const started = await run(
      join(project, "node_modules/.bin/kasbah"),
      ["start", "--schema", "kasbah_test_init", "--to", "15", "--reset"],
      { cwd: project, env, encoding: "utf8" },
    );
    expect(started.stdout).toMatch(/backfill done: 16 handled/);
    const p = new pg.Pool({ connectionString: url, max: 1 });
    const rows = (
      await p.query(
        `SELECT block, timestamp, amount::text FROM kasbah_test_init.counted ORDER BY block`,
      )
    ).rows;
    await p.end();
    // The fake node's block n: timestamp 1000 + n, amount n + 1.
    expect(rows).toEqual(
      Array.from({ length: 16 }, (_, n) => ({
        block: n,
        timestamp: 1_000 + n,
        amount: String(n + 1),
      })),
    );
  },
  120_000,
);

test("kasbah init --template writes each template from the installed package, and each typechecks there", async () => {
  const tarball = readdirSync(dir).find((f) => f.endsWith(".tgz"))!;
  const bin = join(dir, "node_modules/.bin/kasbah");
  const run = promisify(execFile);
  // init only asks the node its chain: no events, so nothing reaches mainnet's cache.
  const mainnet = counterNode(1, { chainId: "0x534e5f4d41494e" });
  await new Promise<void>((r) => mainnet.listen(0, "127.0.0.1", r));
  const mainnetUrl = `http://127.0.0.1:${(mainnet.address() as { port: number }).port}`;
  try {
    await expect(
      run(bin, ["init", "x", "--template", "erc20", "--rpc", rpcUrl, "--yes"], { cwd: dir }),
    ).rejects.toThrow(/the erc20 template indexes mainnet contracts/);
    await expect(
      run(bin, ["init", "x", "--template", "nope", "--rpc", mainnetUrl, "--yes"], { cwd: dir }),
    ).rejects.toThrow(/no template nope \(there are erc20, ekubo, jediswap, pragma\)/);
    for (const template of ["erc20", "ekubo", "jediswap", "pragma"]) {
      const name = `kasbah_test_${template}`;
      const args = ["init", name, "--template", template, "--rpc", mainnetUrl, "--yes"];
      args.push("--database", "", "--dependency", `file:../${tarball}`);
      args.push("--skip-install", "--skip-git");
      await run(bin, args, { cwd: dir });
      const project = join(dir, name);
      // init's message and the dashboard send people to /graphql.
      expect(readFileSync(join(project, "src/api/index.ts"), "utf8")).toContain(
        'app.use("/graphql", graphql(',
      );
      const pnpm = (a: string[]) =>
        execFileSync("pnpm", a, {
          cwd: project,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      pnpm([
        "install",
        "--prefer-offline",
        "--store-dir",
        execFileSync("pnpm", ["store", "path"], { cwd: root, encoding: "utf8" }).trim(),
      ]);
      pnpm(["typecheck"]);
    }
  } finally {
    mainnet.close();
  }
}, 180_000);
