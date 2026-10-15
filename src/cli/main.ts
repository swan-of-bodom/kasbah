#!/usr/bin/env node
// kasbah init [dir] | start [app] | dev [app] | clean [app] | serve [app] | cache info | cache clear [--events] [--calls] [--chain <id>]
// The app module's default export is the value `kasbah(config)` returned. Without an app file, the project's
// kasbah.config.ts, then its src/index.ts (handlers) and src/api/index.ts (routes), which import it.
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, watch } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";
import type { RunOptions } from "../config/app.ts";
import { EventCache } from "../db/cache.ts";
import { Screen } from "./ui/dashboard.ts";
import { type DevDatabase, devDatabase, removeDevDatabase } from "./devdb.ts";
import { init } from "./init.ts";
import { Prompt } from "./ui/prompt.ts";
import { Status } from "../indexer/status.ts";

const USAGE = `usage:
  kasbah init [dir]              a new indexer: asks for the RPC, a contract (its ABI and deployment block
                                        are read from the chain), events and Postgres
    [--rpc <url>] [--address <0x…>] [--name <Name>] [--handle <A,B>] [--start <block>] [--database <url>]
    [--timestamps] [--no-ws] [--yes]    answers as flags; --yes takes the defaults, asks nothing
  kasbah start [app.ts]          index, then follow the head (until --to, or Ctrl-C); without app.ts, the
    [--to <block>] [--reset]            project here: kasbah.config.ts, src/index.ts and src/api/index.ts
  kasbah dev [app.ts]            the same, restarted on every file change (a changed build re-indexes);
    [--reset]                           without DATABASE_URL, a Postgres container (Docker or Podman) for the app;
                                        --reset drops what it stored and starts over (pnpm fresh)
  kasbah clean [app.ts] [--yes]  deletes what the app stored: the dev container and its volume, or with
                                        DATABASE_URL only the app's schema (asks first; the cache stays)
  --ui / --no-ui                        the progress screen (on for dev in a terminal)
  --debug                              with the screen: the fetcher's buffer and windows, waits, event loop delay
  kasbah serve [app.ts]          the API only, over what an indexer of the app stored (more API processes
                                        than indexers, or a finished run)
  kasbah cache info [--chain <id>]
                                        each chain's raw-event and call cache, with its size
  kasbah cache clear [--events] [--calls] [--chain <id>]
Reads .env from the working directory. The cache commands use DATABASE_URL (or --database).`;

type App = { run: (o?: RunOptions) => Promise<void>; serve: () => Promise<{ url: string; close: () => Promise<void> }>; drop: () => Promise<string> };

export const CONFIG = "kasbah.config.ts";
/** What a project registers on the config's app, imported after it when present. */
export const PROJECT_FILES = ["src/index.ts", "src/api/index.ts"];

/** The app file given, or the project's config in the working directory. */
function target(arg: string | undefined): string {
  if (arg !== undefined) return arg;
  if (!existsSync(CONFIG)) throw new Error(`no ${CONFIG} here: run it in a project, or pass the app file`);
  return CONFIG;
}

async function load(file: string): Promise<App> {
  const mod = (await import(pathToFileURL(resolve(file)).href)) as { default?: unknown };
  const app = mod.default as App | undefined;
  if (typeof app?.run !== "function") throw new Error(`${file}: the default export must be the app (export default kasbah(config))`);
  if (file.endsWith(CONFIG)) for (const f of PROJECT_FILES.map((f) => join(dirname(resolve(file)), f))) if (existsSync(f)) await import(pathToFileURL(f).href);
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

async function start(file: string, o: { to?: number; reset?: boolean; dev?: boolean; ui?: boolean; debug?: boolean }) {
  const status = (o.ui ?? (o.dev && process.stdout.isTTY)) ? new Status() : undefined;
  if (status !== undefined) status.debug = o.debug === true;
  const screen = status === undefined ? undefined : new Screen(status);
  screen?.start();
  try {
    const app = await load(file);
    const stop = new AbortController();
    // Ctrl-C reaches this process twice under `kasbah dev` (from the terminal, then from the parent), so a repeat
    // must not kill it before the last commit; a third one does.
    let signals = 0;
    for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => (++signals >= 3 ? process.exit(130) : stop.abort()));
    await app.run({ to: o.to, reset: o.reset, signal: stop.signal, onBuildChange: o.dev ? "reset" : "error", buildSalt: sourceHash(file), status });
  } finally {
    screen?.stop();
  }
}

/**
 * Runs `start --dev` in a child process and restarts it on changes under the app's directory. Without
 * `DATABASE_URL`, a Postgres container for the app, stopped (data kept) when `dev` exits.
 */
async function dev(file: string, ui: boolean | undefined, debug: boolean | undefined, reset: boolean | undefined) {
  const log = (line: string) => console.log(`[kasbah dev] ${line}`);
  let db: DevDatabase | undefined;
  if (process.env.DATABASE_URL === undefined) {
    db = await devDatabase(dirname(resolve(file)), log);
    log(`DATABASE_URL=${db.url}  (delete it all: kasbah clean, or pnpm clean)`);
    process.env.DATABASE_URL = db.url;
  }
  let child: ChildProcess | undefined;
  let exited: Promise<void> = Promise.resolve();
  // --reset only on the first launch: a restart after saving a file keeps what's indexed.
  let resetOnce = reset === true;
  const launch = () => {
    const flags = [...(ui === undefined ? [] : [ui ? "--ui" : "--no-ui"]), ...(debug ? ["--debug"] : []), ...(resetOnce ? ["--reset"] : [])];
    resetOnce = false;
    const c = spawn(process.execPath, [...process.execArgv, import.meta.filename, "start", file, "--dev", ...flags], { stdio: "inherit" });
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
      db?.stop();
      process.exit(0);
    });
  }
  launch();
}

async function serve(file: string) {
  const app = await load(file);
  const api = await app.serve();
  console.log(`[kasbah] API on ${api.url}: GraphiQL at ${api.url}/graphql (Ctrl-C stops it)`);
  await new Promise<void>((r) => {
    process.once("SIGINT", r);
    process.once("SIGTERM", r);
  });
  await api.close();
}

/** `clean`: the dev container and volume when `dev` made them, else only the app's schema in DATABASE_URL. */
async function clean(file: string, yes: boolean | undefined) {
  if (process.env.DATABASE_URL === undefined) {
    const r = removeDevDatabase(dirname(resolve(file)));
    console.log(r.removed ? `deleted ${r.container} and its volume (${r.runtime}); the next dev starts from scratch` : `nothing to delete: no ${r.container}`);
    return;
  }
  const app = await load(file);
  if (!yes) {
    if (!process.stdin.isTTY) throw new Error("clean drops the app's schema in DATABASE_URL: pass --yes to confirm");
    const ok = await new Prompt().confirm("Drop this app's schema in DATABASE_URL (its tables and progress)?", false);
    if (!ok) return void console.log("kept");
  }
  console.log(`dropped schema ${await app.drop()}; the next start indexes from scratch`);
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

// Node warns once that it strips the app's types: expected here, so only other warnings are shown.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name === "ExperimentalWarning" && /type stripping/i.test(w.message)) return;
  console.warn(`(node:${process.pid}) ${w.name}: ${w.message}`);
});

// Like `node --env-file-if-exists=.env`: variables already set win.
try {
  process.loadEnvFile(".env");
} catch (e) {
  if ((e as { code?: string }).code !== "ENOENT") throw e;
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  allowNegative: true,
  options: {
    to: { type: "string" },
    reset: { type: "boolean" },
    dev: { type: "boolean" },
    ui: { type: "boolean" },
    debug: { type: "boolean" },
    ws: { type: "boolean" },
    database: { type: "string" },
    events: { type: "boolean" },
    calls: { type: "boolean" },
    chain: { type: "string" },
    rpc: { type: "string" },
    address: { type: "string" },
    name: { type: "string" },
    start: { type: "string" },
    timestamps: { type: "boolean" },
    yes: { type: "boolean", short: "y" },
    dependency: { type: "string" },
    handle: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
const [command, arg] = positionals;
try {
  if (values.help || command === undefined) console.log(USAGE);
  else if (command === "init") await init({ ...values, dir: arg, events: values.handle });
  else if (command === "start") await start(target(arg), { to: values.to === undefined ? undefined : Number(values.to), reset: values.reset, dev: values.dev, ui: values.ui, debug: values.debug });
  else if (command === "dev") await dev(target(arg), values.ui, values.debug, values.reset);
  else if (command === "clean") await clean(target(arg), values.yes);
  else if (command === "serve") await serve(target(arg));
  else if (command === "cache") await cache(arg, values);
  else {
    console.error(USAGE);
    process.exitCode = 2;
  }
} catch (e) {
  console.error(`[kasbah] ${(e as Error).stack ?? e}`);
  process.exitCode = 1;
}
