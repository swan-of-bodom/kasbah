#!/usr/bin/env node
import { inspect, parseArgs } from "node:util";
import { errorCode } from "../utils/errors.ts";
import { cache } from "./commands/cache.ts";
import { clean } from "./commands/clean.ts";
import { dev } from "./commands/dev.ts";
import { init } from "./commands/init.ts";
import { serve } from "./commands/serve.ts";
import { start } from "./commands/start.ts";
import { target } from "./project.ts";

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
  --schema <name>                       Postgres schema for start, dev, clean and serve (DATABASE_SCHEMA); default:
                                        the config's; dev and clean: else the project directory's name. start and
                                        serve need one (a new one per deploy); one indexer per schema at a time
  --port <n> / --hostname <host>        where the API listens (PORT / API_HOST; default 42069 on localhost)
  --ui / --no-ui                        the progress screen (on for dev in a terminal)
  --debug                              with the screen: the fetcher's buffer and windows, waits, event loop delay
  kasbah serve [app.ts]          the API only, over what an indexer of the app stored (more API processes
                                        than indexers, or a finished run)
  kasbah cache info [--chain <id>]
                                        each chain's raw-event and call cache, with its size
  kasbah cache clear [--events] [--calls] [--chain <id>]
Reads .env from the working directory. The cache commands use DATABASE_URL (or --database).`;

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
    handle: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
const [command, arg] = positionals;
// As environment variables, so `dev`'s child and `resolveConfig` read them like a deployment's.
if (command !== "init" && command !== "cache") {
  if (values.schema !== undefined) process.env.DATABASE_SCHEMA = values.schema;
  if (values.port !== undefined) process.env.PORT = values.port;
  if (values.hostname !== undefined) process.env.API_HOST = values.hostname;
}
try {
  if (values.help || command === undefined) console.log(USAGE);
  else if (command === "init") await init({ ...values, dir: arg, events: values.handle });
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
