import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ApiApp } from "../api/context.ts";
import type { Project, RunOptions, Tables } from "../config/app.ts";
import { ConfigError } from "../config/errors.ts";

export type App = {
  run: (o?: RunOptions) => Promise<void>;
  serve: () => Promise<{ url: string; close: () => Promise<void> }>;
  drop: () => Promise<string>;
  useProject: (p: Project) => void;
  api: (app: ApiApp) => void;
};

export const CONFIG = "kasbah.config.ts";
/** The project's tables, when the config doesn't pass `tables`. */
export const SCHEMA = "kasbah.schema.ts";
/** A project's handlers, registered on the config's app: imported after it, when present. */
export const HANDLERS = "src/index.ts";
/** A project's HTTP endpoints: its default export, a Hono app, is mounted after kasbah's own. */
export const API = "src/api/index.ts";

/** The app file given, or the project's config in the working directory. */
export function target(arg: string | undefined): string {
  if (arg !== undefined) return arg;
  if (!existsSync(CONFIG))
    throw new ConfigError(`no ${CONFIG} here: run it in a project, or pass the app file`);
  return CONFIG;
}

/** `schemaRequired`: `start` and `serve`, which never take the schema from the directory's name. */
export async function load(file: string, o: { schemaRequired?: boolean } = {}): Promise<App> {
  const mod = (await import(pathToFileURL(resolve(file)).href)) as { default?: unknown };
  const app = mod.default as App | undefined;
  if (typeof app?.run !== "function")
    throw new ConfigError(
      `${file}: the default export must be the app (export default kasbah(config))`,
    );
  if (file.endsWith(CONFIG)) {
    const dir = dirname(resolve(file));
    const schema = join(dir, SCHEMA);
    const tables = existsSync(schema)
      ? ((await import(pathToFileURL(schema).href)) as Tables)
      : undefined;
    app.useProject({ name: basename(dir), tables, schemaRequired: o.schemaRequired });
    if (existsSync(join(dir, HANDLERS))) await import(pathToFileURL(join(dir, HANDLERS)).href);
    if (existsSync(join(dir, API))) {
      const api = (await import(pathToFileURL(join(dir, API)).href)) as { default?: ApiApp };
      if (typeof api.default?.fetch !== "function")
        throw new ConfigError(
          `${API}: the default export must be a Hono app (const app = new Hono(); … export default app)`,
        );
      app.api(api.default);
    }
  }
  return app;
}

export const IGNORED = /(^|\/)(node_modules|\.git)(\/|$)/;
export const CODE = /\.(ts|mts|js|mjs|cjs|json)$/;
/** Not code: reinstalling a dependency rewrites it, and that alone mustn't re-index. */
const NOT_HASHED = /(^|\/)package\.json$/;
/** A project's files that don't decide rows: its API, and tests. */
const NOT_INDEXING = /^src\/api\/|\.(test|spec)\.[a-z]+$/;

/**
 * A hash of the code that decides which rows get written: part of the build id, with the config's contracts and
 * the tables (`buildIdOf`). In a project, the files under `src/` but `src/api/` and tests, so editing a route or
 * the config's settings keeps the indexed data. A single-file app hashes every code file beside it.
 */
export function sourceHash(file: string): string {
  const project = file.endsWith(CONFIG);
  const root = project ? join(dirname(resolve(file)), "src") : dirname(resolve(file));
  const h = createHash("sha256");
  const files = (existsSync(root) ? (readdirSync(root, { recursive: true }) as string[]) : [])
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => !IGNORED.test(f) && CODE.test(f) && !NOT_HASHED.test(f))
    .filter((f) => !project || !NOT_INDEXING.test(`src/${f}`))
    .sort();
  for (const f of files)
    h.update(relative(root, join(root, f)))
      .update("\0")
      .update(readFileSync(join(root, f)))
      .update("\0");
  return h.digest("hex").slice(0, 16);
}
