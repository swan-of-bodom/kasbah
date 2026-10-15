import { type ChildProcess, spawn } from "node:child_process";
import { watch } from "node:fs";
import { dirname, resolve } from "node:path";
import { type DevDatabase, devDatabase } from "../devdb.ts";
import { CODE, IGNORED } from "../project.ts";

/**
 * Runs `start --dev` (through `cli`, the command's entry file) in a child process and restarts it on changes under the
 * app's directory. Without `DATABASE_URL`, a Postgres container for the app, stopped (data kept) when `dev` exits.
 */
export async function dev(cli: string, file: string, o: { ui?: boolean; debug?: boolean; reset?: boolean }) {
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
  let resetOnce = o.reset === true;
  const launch = () => {
    const flags = [...(o.ui === undefined ? [] : [o.ui ? "--ui" : "--no-ui"]), ...(o.debug ? ["--debug"] : []), ...(resetOnce ? ["--reset"] : [])];
    resetOnce = false;
    const c = spawn(process.execPath, [...process.execArgv, cli, "start", file, "--dev", ...flags], { stdio: "inherit" });
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
