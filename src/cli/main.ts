#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inspect, parseArgs } from "node:util";
import { errorCode } from "../utils/errors.ts";
import { cache } from "./commands/cache.ts";
import { clean } from "./commands/clean.ts";
import { dev } from "./commands/dev.ts";
import { init } from "./commands/init.ts";
import { list } from "./commands/list.ts";
import { prune } from "./commands/prune.ts";
import { serve } from "./commands/serve.ts";
import { start } from "./commands/start.ts";
import { target } from "./project.ts";

const USAGE = `usage:
  kasbah init [dir]              a new indexer from a contract or a template (kasbah init --help)
  kasbah start [app.ts]          index, then follow the head (until --to, or Ctrl-C); without app.ts, the
    [--to <block>] [--reset]            project here: kasbah.config.ts, src/index.ts and src/api/index.ts
  kasbah dev [app.ts]            the same, restarted on every file change (a changed build re-indexes);
    [--reset]                           without DATABASE_URL, a Postgres container (Docker or Podman) for the app;
                                        --reset drops what it stored and starts over (pnpm fresh)
  kasbah clean [app.ts] [--yes]  deletes what the app stored: the dev container and its volume, or with
                                        DATABASE_URL only the app's schema (asks first; the cache stays)
  --schema <name>                       Postgres schema for start, dev, clean and serve (DATABASE_SCHEMA); default:
                                        the config's; dev and clean: else the project directory's name. start and
                                        serve need one (a new one per deploy); one indexer per schema at a time
  --port <n> / --hostname <host>        where the API listens (PORT / API_HOST; default 42069 on localhost)
  --ui / --no-ui                        the progress screen (on for dev in a terminal)
  --debug                              with the screen: the fetcher's buffer and windows, waits, event loop delay
  kasbah list                    with DATABASE_URL, its app schemas (running or not, phase, last block, size,
                                        last active) and event caches; then every dev database on the machine
                                        (the containers \`dev\` made), with its port, size and app directory
  kasbah prune [--yes]           drops every schema in DATABASE_URL no indexer is running (asks first); the
                                        cache stays
  kasbah serve [app.ts]          the API only, over what an indexer of the app stored (more API processes
                                        than indexers, or a finished run)
  kasbah cache clear [--events] [--calls] [--chain <id>]
                                        empties the raw-event and call caches (list shows them)
Reads .env from the working directory. The cache, list and prune commands use DATABASE_URL (or --database).`;

/** `kasbah init --help`, which `pnpm create kasbah --help` shows too. */
const INIT_USAGE = `usage: kasbah init [dir] [options]   (or pnpm create kasbah [dir] [options])

A new Starknet indexer: asks for the directory, what to start from, the RPC and Postgres, then installs the
packages and makes a git repository.

  -t, --template <name>    start from a template (mainnet):
                             erc20     LORDS: balances, transfers and allowances, with GraphQL relations
                             ekubo     Ekubo's Core: every pool, with its swaps
                             jediswap  JediSwap v1: the pairs its factory creates, with their swaps and reserves
                             pragma    Pragma's ETH, BTC and STRK prices, read from its oracle every 2,000 blocks
  --address <0x…>          or from a contract: its ABI and deployment block are read from the chain
    --name <Name>            its name in the app (handlers are <Name>:<Event>)
    --handle <A,B>           the events to index (default: all)
    --start <block>          the first block (default: its deployment)
    --timestamps             store each event's block timestamp (one call per block with events)
  --rpc <url>              a spec 0.10 RPC (default: KASBAH_RPC_URL, else a free public one)
  --database <url>         Postgres (empty: \`dev\` runs one in a container)
  --no-ws                  poll for new blocks instead of a WebSocket
  --npm, --pnpm, --yarn    the package manager (default: the one running create, else pnpm)
  --skip-install           don't install the packages
  --skip-git               don't make a git repository
  -y, --yes                take the defaults, ask nothing
  -h, --help               this
  -v, --version            kasbah's version`;

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
  if (errorCode(e) !== "ENOENT") throw e;
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
    schema: { type: "string" },
    port: { type: "string" },
    hostname: { type: "string" },
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
    template: { type: "string", short: "t" },
    npm: { type: "boolean" },
    pnpm: { type: "boolean" },
    yarn: { type: "boolean" },
    "skip-install": { type: "boolean" },
    "skip-git": { type: "boolean" },
    version: { type: "boolean", short: "v" },
    handle: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
const [command, arg] = positionals;
// As environment variables, so `dev`'s child and `resolveConfig` read them like a deployment's.
// `dev` shows API errors in full to the client (`detailedErrors`); elsewhere, unless set, they're masked.
if (command === "dev") process.env.NODE_ENV ??= "development";
if (command !== "init" && command !== "cache") {
  if (values.schema !== undefined) process.env.DATABASE_SCHEMA = values.schema;
  if (values.port !== undefined) process.env.PORT = values.port;
  if (values.hostname !== undefined) process.env.API_HOST = values.hostname;
}
try {
  if (values.version) console.log(version());
  else if (values.help && command === "init") console.log(INIT_USAGE);
  else if (values.help || command === undefined) console.log(USAGE);
  else if (command === "init")
    await init({
      ...values,
      dir: arg,
      events: values.handle,
      packageManager: values.npm ? "npm" : values.yarn ? "yarn" : values.pnpm ? "pnpm" : undefined,
      skipInstall: values["skip-install"],
      skipGit: values["skip-git"],
    });
  else if (command === "start")
    await start(target(arg), {
      to: values.to === undefined ? undefined : Number(values.to),
      reset: values.reset,
      dev: values.dev,
      ui: values.ui,
      debug: values.debug,
    });
  else if (command === "dev")
    await dev(import.meta.filename, target(arg), {
      ui: values.ui,
      debug: values.debug,
      reset: values.reset,
    });
  else if (command === "clean") await clean(target(arg), values.yes);
  else if (command === "list") await list(values);
  else if (command === "prune") await prune(values);
  else if (command === "serve") await serve(target(arg));
  else if (command === "cache") await cache(arg, values);
  else {
    console.error(USAGE);
    process.exitCode = 2;
  }
} catch (e) {
  console.error(
    `[kasbah] ${(e as Error)?.name === "ConfigError" ? (e as Error).message : inspect(e)}`,
  );
  process.exitCode = 1;
}

function version(): string {
  const file = resolve(import.meta.dirname, "../../package.json");
  return (JSON.parse(readFileSync(file, "utf8")) as { version: string }).version;
}
