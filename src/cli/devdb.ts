import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import pg from "pg";

export const IMAGE = "postgres:17";

export type DevDatabase = { url: string; container: string; runtime: string; stop: () => void };

const run = (runtime: string, args: string[], inherit = false) =>
  spawnSync(runtime, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", inherit ? "inherit" : "pipe"],
  });

function findRuntime(): string | undefined {
  const preferred = process.env.KASBAH_CONTAINER;
  for (const r of preferred === undefined ? ["docker", "podman"] : [preferred])
    if (run(r, ["version"]).status === 0) return r;
  return undefined;
}

/** One container per app directory: its basename and a hash of its path, so two apps never share a database. */
export function containerName(appDir: string): string {
  const dir = resolve(appDir);
  const slug =
    basename(dir)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 30) || "app";
  return `kasbah-${slug}-${createHash("sha256").update(dir).digest("hex").slice(0, 6)}`;
}

/**
 * For `dev` without `DATABASE_URL`: starts (or creates, pulling the image the first time) a Postgres container for
 * the app, data in a named volume that outlives it, listening on a free localhost port.
 */
export async function devDatabase(
  appDir: string,
  log: (line: string) => void,
): Promise<DevDatabase> {
  const runtime = findRuntime();
  if (runtime === undefined)
    throw new Error(
      "no DATABASE_URL: set it in .env, or install Docker or Podman for a dev database",
    );
  const container = containerName(appDir);
  const state = run(runtime, ["inspect", "--format", "{{.State.Running}}", container]);
  if (state.status !== 0) {
    log(
      `no DATABASE_URL: creating ${container} (${IMAGE} with ${runtime}, data in volume ${container})`,
    );
    const created = run(
      runtime,
      [
        "run",
        "-d",
        "--name",
        container,
        "--label",
        "kasbah=dev",
        "-e",
        "POSTGRES_PASSWORD=kasbah",
        "-e",
        "POSTGRES_DB=kasbah",
        "-p",
        "127.0.0.1::5432",
        "-v",
        `${container}:/var/lib/postgresql/data`,
        IMAGE,
      ],
      true,
    );
    if (created.status !== 0)
      throw new Error(`${runtime} run ${IMAGE} failed: ${created.stdout.trim()}`);
  } else if (state.stdout.trim() !== "true") {
    log(`no DATABASE_URL: starting ${container}`);
    const started = run(runtime, ["start", container]);
    if (started.status !== 0)
      throw new Error(`${runtime} start ${container} failed: ${started.stderr.trim()}`);
  } else log(`no DATABASE_URL: using ${container}`);

  const port = /:(\d+)\s*$/m.exec(run(runtime, ["port", container, "5432/tcp"]).stdout)?.[1];
  if (port === undefined) throw new Error(`${container} publishes no port for 5432`);
  const url = `postgresql://postgres:kasbah@127.0.0.1:${port}/kasbah`;
  // The image runs a socket-only server while it initialises: TCP answers once the real one is up.
  const end = Date.now() + 60_000;
  for (;;) {
    const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
    try {
      await c.connect();
      await c.query("SELECT 1");
      break;
    } catch (e) {
      if (Date.now() > end)
        throw new Error(
          `${container} not accepting connections after 60 s: ${(e as Error).message}`,
        );
      await new Promise((r) => setTimeout(r, 250));
    } finally {
      await c.end().catch(() => {});
    }
  }
  return { url, container, runtime, stop: () => void run(runtime, ["stop", container]) };
}

/** Deletes the app's dev container and its volume (the data). Returns what was there to delete. */
export function removeDevDatabase(appDir: string): {
  container: string;
  runtime: string;
  removed: boolean;
} {
  const runtime = findRuntime();
  if (runtime === undefined)
    throw new Error("no DATABASE_URL and no Docker or Podman: nothing to delete");
  const container = containerName(appDir);
  const had = run(runtime, ["inspect", container]).status === 0;
  const volume = run(runtime, ["volume", "inspect", container]).status === 0;
  if (had) run(runtime, ["rm", "-fv", container]);
  if (volume && run(runtime, ["volume", "rm", container]).status !== 0)
    throw new Error(`${runtime} volume rm ${container} failed`);
  return { container, runtime, removed: had || volume };
}
