import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import pg from "pg";
import { ConfigError } from "../config/errors.ts";
import { sleep } from "../utils/sleep.ts";

/** Fully qualified: Podman refuses or prompts for a short name, depending on the distro's registries. */
export const IMAGE = "docker.io/library/postgres:17";

/** The label holding the app directory a dev container belongs to, which `kasbah list` shows. */
export const APP_LABEL = "kasbah.app";

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
    throw new ConfigError(
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
        "--label",
        `${APP_LABEL}=${resolve(appDir)}`,
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
      await sleep(250);
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
    throw new ConfigError("no DATABASE_URL and no Docker or Podman: nothing to delete");
  const container = containerName(appDir);
  const had = run(runtime, ["inspect", container]).status === 0;
  const volume = run(runtime, ["volume", "inspect", container]).status === 0;
  if (had) run(runtime, ["rm", "-fv", container]);
  if (volume && run(runtime, ["volume", "rm", container]).status !== 0)
    throw new Error(`${runtime} volume rm ${container} failed`);
  return { container, runtime, removed: had || volume };
}

/** A dev container as `kasbah list` shows it. */
export type DevDatabaseInfo = {
  container: string;
  running: boolean;
  /** The localhost port Postgres is published on, while running. */
  port?: string;
  /** Its volume's size, as the runtime reports it; undefined when it reports none. */
  bytes?: number;
  /** The app directory, for containers made since `dev` labels it. */
  app?: string;
};

/** Every dev container on the machine (label `kasbah=dev`), with its volume's size; undefined without a runtime. */
export function listDevDatabases(): { runtime: string; databases: DevDatabaseInfo[] } | undefined {
  const runtime = findRuntime();
  if (runtime === undefined) return undefined;
  const names = run(runtime, ["ps", "-a", "--filter", "label=kasbah=dev", "--format", "{{.Names}}"])
    .stdout.split("\n")
    .map((n) => n.trim())
    .filter((n) => n !== "");
  if (names.length === 0) return { runtime, databases: [] };
  const inspected = run(runtime, [
    "inspect",
    "--format",
    `{{.Name}}\t{{.State.Running}}\t{{index .Config.Labels "${APP_LABEL}"}}`,
    ...names,
  ]).stdout;
  const sizes = volumeSizes(run(runtime, ["system", "df", "-v"]).stdout);
  const databases = inspected
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l): DevDatabaseInfo => {
      const [name = "", running, app] = l.split("\t");
      const container = name.replace(/^\//, "");
      const up = running === "true";
      const port = up
        ? /:(\d+)\s*$/m.exec(run(runtime, ["port", container, "5432/tcp"]).stdout)?.[1]
        : undefined;
      return {
        container,
        running: up,
        port,
        bytes: sizes.get(container),
        app: app === undefined || app === "" || app === "<no value>" ? undefined : app,
      };
    })
    .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
  return { runtime, databases };
}

/** The volume sizes in `docker|podman system df -v`: its table under "VOLUME NAME", up to the next blank line. */
export function volumeSizes(df: string): Map<string, number> {
  const sizes = new Map<string, number>();
  let inVolumes = false;
  for (const line of df.split("\n")) {
    if (/^VOLUME NAME\s/.test(line)) {
      inVolumes = true;
      continue;
    }
    if (!inVolumes) continue;
    if (line.trim() === "") break;
    const cols = line.trim().split(/\s+/);
    const size = parseSize(cols.at(-1) ?? "");
    if (cols[0] !== undefined && size !== undefined) sizes.set(cols[0], size);
  }
  return sizes;
}

const UNITS: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };

/** A size as Docker and Podman print it ("65.08GB", "12.41kB", "0B"): decimal units, as theirs are. */
export function parseSize(s: string): number | undefined {
  const m = /^([\d.]+)\s*([kKMGT]?B)$/.exec(s);
  const unit = m?.[2] === undefined ? undefined : UNITS[m[2].toUpperCase()];
  return m?.[1] === undefined || unit === undefined ? undefined : Number(m[1]) * unit;
}
