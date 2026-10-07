#!/usr/bin/env node
// kasbah start <app> | kasbah dev <app> | kasbah cache info | kasbah cache clear [--events] [--calls] [--chain <id>]
// The app module's default export is the value `kasbah(config)` returned, with its handlers registered.
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, watch } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";
import type { RunOptions } from "./app.ts";
import { EventCache } from "./cache.ts";
import { Screen } from "./dashboard.ts";
import { Status } from "./status.ts";

const USAGE = `usage:
  kasbah start <app.ts> [--to <block>] [--reset]   index, then follow the head (until --to, or Ctrl-C)
  kasbah dev <app.ts>                              the same, restarted on every file change; a changed
                                                   build re-indexes from scratch
  --ui / --no-ui                                   the progress screen (on for dev in a terminal)
  kasbah cache info [--chain <id>]                 each chain's raw-event and call cache, with its size
  kasbah cache clear [--events] [--calls] [--chain <id>]
Reads .env from the working directory. The cache commands use DATABASE_URL (or --database).`;

type App = { run: (o?: RunOptions) => Promise<void> };

async function load(file: string): Promise<App> {
  const mod = (await import(pathToFileURL(resolve(file)).href)) as { default?: unknown };
  const app = mod.default as App | undefined;
  if (typeof app?.run !== "function") throw new Error(`${file}: the default export must be the app (export default kasbah(config) after its handlers)`);
  return app;
}

const IGNORED = /(^|\/)(node_modules|\.git)(\/|$)/;
const CODE = /\.(ts|mts|js|mjs|cjs|json)$/;

/** A hash of the code files under the app's directory: part of the build id, like Ponder's. */
function sourceHash(file: string): string {
  const root = dirname(resolve(file));
  const h = createHash("sha256");
  const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => !IGNORED.test(f) && CODE.test(f)).sort();
  for (const f of files) h.update(relative(root, join(root, f))).update("\0").update(readFileSync(join(root, f))).update("\0");
  return h.digest("hex").slice(0, 16);
}

async function start(file: string, o: { to?: number; reset?: boolean; dev?: boolean; ui?: boolean }) {
  const status = (o.ui ?? (o.dev && process.stdout.isTTY)) ? new Status() : undefined;
  const screen = status === undefined ? undefined : new Screen(status);
  screen?.start();
  try {
    const app = await load(file);
    const stop = new AbortController();
    for (const s of ["SIGINT", "SIGTERM"] as const) process.once(s, () => stop.abort());
    await app.run({ to: o.to, reset: o.reset, signal: stop.signal, onBuildChange: o.dev ? "reset" : "error", buildSalt: sourceHash(file), status, log: screen?.log });
  } finally {
    screen?.stop();
  }
}

/** Runs `start --dev` in a child process and restarts it on changes under the app's directory. */
function dev(file: string, ui: boolean | undefined) {
  const log = (line: string) => console.log(`[kasbah dev] ${line}`);
  let child: ChildProcess | undefined;
  let exited: Promise<void> = Promise.resolve();
  const launch = () => {
    const c = spawn(process.execPath, [...process.execArgv, import.meta.filename, "start", file, "--dev", ...(ui === undefined ? [] : [ui ? "--ui" : "--no-ui"])], { stdio: "inherit" });
    child = c;
    exited = new Promise((r) =>
      c.once("exit", (code, signal) => {
        if (child === c) {
          child = undefined;
          if (code !== 0 && signal === null) log(`stopped (exit ${code}); waiting for a change`);
        }
        r();
      }),
    );
  };
  let timer: NodeJS.Timeout | undefined;
  let restarting = false;
  const restart = async () => {
    if (restarting) return;
    restarting = true;
    try {
      const c = child;
      child = undefined;
      c?.kill("SIGINT");
      await exited;
      log("change detected, restarting");
      launch();
    } finally {
      restarting = false;
    }
  };
  const watcher = watch(dirname(resolve(file)), { recursive: true }, (_, name) => {
    if (name === null || IGNORED.test(name) || !CODE.test(name)) return;
    clearTimeout(timer);
    timer = setTimeout(() => void restart(), 150);
  });
  for (const s of ["SIGINT", "SIGTERM"] as const) {
    process.once(s, async () => {
      watcher.close();
      clearTimeout(timer);
      child?.kill("SIGINT");
      await exited;
      process.exit(0);
    });
  }
  launch();
}

async function cache(command: string | undefined, o: { database?: string; events?: boolean; calls?: boolean; chain?: string }) {
  const database = o.database ?? process.env.DATABASE_URL;
  if (database === undefined) throw new Error("set DATABASE_URL or pass --database");
  const pool = new pg.Pool({ connectionString: database, max: 1 });
  try {
    if (command === "info") {
      const info = await EventCache.info(pool, o.chain);
      if (info.length === 0) console.log("no caches");
      for (const c of info) console.log(`${c.schema}: ${c.events} events, ${c.transactions} transactions, ${c.calls} calls, ${c.headers} headers, ${(c.bytes / 2 ** 20).toFixed(1)} MB`);
    } else if (command === "clear") {
      const what = o.events || o.calls ? { events: o.events, calls: o.calls } : { events: true, calls: true };
      await EventCache.clear(pool, what, o.chain);
      console.log(`cleared ${[what.events && "events", what.calls && "calls"].filter(Boolean).join(" and ")}${o.chain === undefined ? "" : ` for ${o.chain}`}`);
    } else throw new Error(USAGE);
  } finally {
    await pool.end();
  }
}

// Like `node --env-file-if-exists=.env`: variables already set win.
try {
  process.loadEnvFile(".env");
} catch {}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  allowNegative: true,
  options: {
    to: { type: "string" },
    reset: { type: "boolean" },
    dev: { type: "boolean" },
    ui: { type: "boolean" },
    database: { type: "string" },
    events: { type: "boolean" },
    calls: { type: "boolean" },
    chain: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
const [command, arg] = positionals;
try {
  if (values.help || command === undefined) console.log(USAGE);
  else if (command === "start" && arg !== undefined) await start(arg, { to: values.to === undefined ? undefined : Number(values.to), reset: values.reset, dev: values.dev, ui: values.ui });
  else if (command === "dev" && arg !== undefined) dev(arg, values.ui);
  else if (command === "cache") await cache(arg, values);
  else {
    console.error(USAGE);
    process.exitCode = 2;
  }
} catch (e) {
  console.error(`[kasbah] ${(e as Error).stack ?? e}`);
  process.exitCode = 1;
}
