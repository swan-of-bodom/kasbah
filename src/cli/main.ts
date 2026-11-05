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
import { commandHelp, isCommand, mainHelp } from "./help.ts";
import { target } from "./project.ts";

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
  else if (command === undefined || (command === "help" && arg === undefined))
    console.log(mainHelp());
  else if (command === "help" || values.help) {
    const topic = command === "help" ? arg! : command;
    if (isCommand(topic)) console.log(commandHelp(topic));
    else unknown(topic);
  } else if (command === "init")
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
  else unknown(command);
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

/** A command kasbah doesn't have: the commands it has, and exit code 2, as for any wrong usage. */
function unknown(command: string) {
  console.error(`[kasbah] no command ${command}\n\n${mainHelp()}`);
  process.exitCode = 2;
}
