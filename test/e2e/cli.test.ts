import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { containerName } from "../../src/cli/devdb.ts";
import { counterAbi, counterNode } from "../fixtures/counter.ts";

const url = process.env.DATABASE_URL;
const schema = "kasbah_test_cli";
const BLOCKS = 40;
const abi = counterAbi;
const server = counterNode(BLOCKS);
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
    return (await p.query(`SELECT total::text FROM ${schema}.totals WHERE id = 'all'`)).rows[0]
      ?.total as string | undefined;
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
/** `dev` refuses a schema `start` made: the tests that switch between them start clean. */
const dropSchema = async () => {
  const p = new pg.Pool({ connectionString: url, max: 1 });
  await p.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await p.end();
};
const cli = (...args: string[]) => {
  const out: string[] = [];
  const p = spawn(process.execPath, ["--no-warnings", "src/cli/main.ts", ...args], {
    env: { ...process.env, DATABASE_URL: url },
  });
  p.stdout.on("data", (d) => out.push(String(d)));
  p.stderr.on("data", (d) => out.push(String(d)));
  return { p, out, exited: new Promise<number | null>((r) => p.once("exit", r)) };
};

test.skipIf(url === undefined)(
  "start --to indexes final blocks and exits; a changed build is refused",
  async () => {
    writeFileSync(appFile, appSource(1).replace('"RPC"', JSON.stringify(rpcUrl)));
    const run = cli("start", appFile, "--to", String(BLOCKS - 1), "--reset");
    expect(await run.exited).toBe(0);
    // The head is block 39 and 4 blocks can still be reorged: indexed through 35 (amounts 1..36).
    expect(await total()).toBe(String((36 * 37) / 2));
    expect(run.out.join("")).toMatch(
      /--to 39 is past block 35, the last one that can't be reorged/,
    );

    writeFileSync(appFile, appSource(2).replace('"RPC"', JSON.stringify(rpcUrl)));
    const refused = cli("start", appFile, "--to", String(BLOCKS - 1));
    expect(await refused.exited).toBe(1);
    expect(refused.out.join("")).toMatch(/holds another build/);
  },
  60_000,
);

test.skipIf(url === undefined)(
  "dev: restarts on a change and re-indexes a changed build",
  async () => {
    await dropSchema();
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
  },
  60_000,
);

test.skipIf(url === undefined)(
  "dev --reset re-indexes from block 0; clean drops the app's schema (with --yes when not asked)",
  async () => {
    await dropSchema();
    writeFileSync(appFile, appSource(4).replace('"RPC"', JSON.stringify(rpcUrl)));
    const first = cli("dev", appFile, "--no-ui");
    await until(async () => /backfill done/.test(first.out.join("")));
    first.p.kill("SIGINT");
    expect(await first.exited).toBe(0);
    const run = cli("dev", appFile, "--reset", "--no-ui");
    try {
      await until(async () => /backfill done: (\d+) handled/.test(run.out.join("")));
      expect(Number(/backfill done: (\d+) handled/.exec(run.out.join(""))![1])).toBeGreaterThan(30);
    } finally {
      run.p.kill("SIGINT");
    }
    expect(await run.exited).toBe(0);
    // Stopped after the backfill (through block 35), maybe a little into live.
    expect(Number(await total())).toBeGreaterThanOrEqual(4 * ((36 * 37) / 2));

    const refused = cli("clean", appFile);
    expect(await refused.exited).toBe(1);
    expect(refused.out.join("")).toMatch(/pass --yes/);
    const cleaned = cli("clean", appFile, "--yes");
    expect(await cleaned.exited).toBe(0);
    expect(cleaned.out.join("")).toContain(`dropped schema ${schema}`);
    expect(await total()).toBeUndefined();
  },
  90_000,
);

test("a mistake to fix prints its message, without a stack", () => {
  const { DATABASE_URL: _, ...env } = process.env;
  const r = spawnSync(
    process.execPath,
    ["--no-warnings", resolve("src/cli/main.ts"), "cache", "info"],
    {
      env,
      cwd: dir,
      encoding: "utf8",
    },
  );
  expect([r.status, r.stderr]).toEqual([1, "[kasbah] set DATABASE_URL or pass --database\n"]);
});

test.skipIf(url === undefined)("cache info runs", async () => {
  const run = cli("cache", "info", "--chain", "0x0");
  expect(await run.exited).toBe(0);
});

test.skipIf(url === undefined)(
  "a second Ctrl-C waits for the block being handled; a third exits at once",
  async () => {
    // Every handler takes 1 s: the signals arrive while one runs.
    const slow = appSource(1)
      .replace('"RPC"', JSON.stringify(rpcUrl))
      .replace("const v =", "await new Promise((r) => setTimeout(r, 1_000));\n  const v =");
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    writeFileSync(appFile, slow);
    const twice = cli("start", appFile, "--reset");
    await until(async () => twice.out.join("").includes("1 contract"));
    await pause(300);
    twice.p.kill("SIGINT");
    await pause(200);
    twice.p.kill("SIGINT");
    expect(await twice.exited).toBe(0);

    const thrice = cli("start", appFile, "--reset");
    await until(async () => thrice.out.join("").includes("1 contract"));
    await pause(300);
    for (let i = 0; i < 3; i++) {
      thrice.p.kill("SIGINT");
      await pause(100);
    }
    expect(await thrice.exited).toBe(130);
  },
  60_000,
);

const hasRuntime = ["docker", "podman"].some((r) => spawnSync(r, ["version"]).status === 0);
test.skipIf(!hasRuntime)(
  "dev without DATABASE_URL: a Postgres container for the app, stopped with dev, data kept",
  async () => {
    const name = containerName(dir);
    const runtime = spawnSync("docker", ["version"]).status === 0 ? "docker" : "podman";
    const remove = () => {
      spawnSync(runtime, ["rm", "-fv", name]);
      spawnSync(runtime, ["volume", "rm", "-f", name]);
    };
    remove();
    writeFileSync(appFile, appSource(1).replace('"RPC"', JSON.stringify(rpcUrl)));
    const start = () => {
      const out: string[] = [];
      const { DATABASE_URL: _, ...env } = process.env;
      // From the app's directory: the repo's .env would set DATABASE_URL.
      const p = spawn(
        process.execPath,
        ["--no-warnings", resolve("src/cli/main.ts"), "dev", appFile, "--no-ui"],
        { env, cwd: dir },
      );
      p.stdout.on("data", (d) => out.push(String(d)));
      p.stderr.on("data", (d) => out.push(String(d)));
      return { p, out, exited: new Promise<number | null>((r) => p.once("exit", r)) };
    };
    try {
      const first = start();
      await until(async () => first.out.join("").includes("following the head"), 90_000).catch(
        (e) => {
          console.log(first.out.join(""));
          throw e;
        },
      );
      expect(first.out.join("")).toContain(`creating ${name}`);
      first.p.kill("SIGINT");
      expect(await first.exited).toBe(0);
      expect(
        spawnSync(runtime, ["inspect", "--format", "{{.State.Running}}", name], {
          encoding: "utf8",
        }).stdout.trim(),
      ).toBe("false");

      const second = start();
      await until(async () => second.out.join("").includes("following the head"), 90_000);
      expect(second.out.join("")).toContain(`starting ${name}`);
      expect(second.out.join("")).not.toMatch(/backfill done: [1-9]/);
      second.p.kill("SIGINT");
      expect(await second.exited).toBe(0);

      const { DATABASE_URL: _, ...env } = process.env;
      const cleaned = spawnSync(
        process.execPath,
        ["--no-warnings", resolve("src/cli/main.ts"), "clean", appFile],
        { env, cwd: dir, encoding: "utf8" },
      );
      expect(cleaned.stdout).toContain(`deleted ${name} and its volume`);
      expect(spawnSync(runtime, ["inspect", name]).status).not.toBe(0);
      expect(spawnSync(runtime, ["volume", "inspect", name]).status).not.toBe(0);
    } finally {
      remove();
    }
  },
  240_000,
);

test.skipIf(url === undefined)(
  "a project's layout gives the tables (kasbah.schema.ts) and the API; start needs a schema",
  async () => {
    const project = join(dir, "layout-app");
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(
      join(project, "kasbah.schema.ts"),
      `import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { bignum } from ${JSON.stringify(index)};
export const totals = pgTable("totals", { id: text().primaryKey(), total: bignum().notNull(), n: integer().notNull() });
`,
    );
    writeFileSync(
      join(project, "kasbah.config.ts"),
      `import { kasbah } from ${JSON.stringify(index)};
export default kasbah({ rpc: ${JSON.stringify(rpcUrl)},
  contracts: { C: { abi: ${JSON.stringify(abi)}, address: "0xc", startBlock: 0 } }, pollMs: 50, reorgWindow: 4 });
`,
    );
    writeFileSync(
      join(project, "src/index.ts"),
      `import app from "../kasbah.config.ts";
import { totals } from "../kasbah.schema.ts";
app.on("C:Counted", async ({ event, context }) => {
  await context.db.insert(totals).values({ id: "all", total: event.args.amount, n: 1 }).onConflictDoUpdate((r) => ({ total: r.total + event.args.amount, n: r.n + 1 }));
});
`,
    );
    const unnamed = cli("start", join(project, "kasbah.config.ts"), "--to", String(BLOCKS - 1));
    expect(await unnamed.exited).toBe(1);
    expect(unnamed.out.join("")).toMatch(/no schema: pass --schema or set DATABASE_SCHEMA/);
    const run = cli(
      "start",
      join(project, "kasbah.config.ts"),
      "--schema",
      "layout_app",
      "--to",
      String(BLOCKS - 1),
      "--reset",
      "--port",
      "0",
    );
    expect(await run.exited).toBe(0);
    expect(run.out.join("")).toMatch(/API on http:\/\/localhost:\d+/);
    const p = new pg.Pool({ connectionString: url, max: 1 });
    try {
      const r = await p.query("SELECT total::text FROM layout_app.totals WHERE id = 'all'");
      expect(r.rows[0]?.total).toBe(String((36 * 37) / 2));
      await p.query("DROP SCHEMA layout_app CASCADE");
    } finally {
      await p.end();
    }
  },
  60_000,
);

test.skipIf(url === undefined)(
  "serve: the API alone, over what a run stored",
  async () => {
    writeFileSync(
      appFile,
      appSource(1)
        .replace('"RPC"', JSON.stringify(rpcUrl))
        .replace("tables: { totals },", "tables: { totals }, api: { port: 0 },"),
    );
    expect(await cli("start", appFile, "--to", String(BLOCKS - 1), "--reset").exited).toBe(0);
    const served = cli("serve", appFile);
    await until(async () => /API on (\S+):/.test(served.out.join("")));
    const base = /API on (\S+):/.exec(served.out.join(""))![1]!;
    const r = await fetch(`${base}/sql`, {
      method: "POST",
      body: JSON.stringify({ sql: "select total::text from totals" }),
    });
    expect((await r.json()).rows).toEqual([[String((36 * 37) / 2)]]);
    served.p.kill("SIGINT");
    expect(await served.exited).toBe(0);
  },
  60_000,
);
