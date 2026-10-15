import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { RunOptions } from "../config/app.ts";

export type App = { run: (o?: RunOptions) => Promise<void>; serve: () => Promise<{ url: string; close: () => Promise<void> }>; drop: () => Promise<string> };

export const CONFIG = "kasbah.config.ts";
/** What a project registers on the config's app, imported after it when present. */
export const PROJECT_FILES = ["src/index.ts", "src/api/index.ts"];

/** The app file given, or the project's config in the working directory. */
export function target(arg: string | undefined): string {
  if (arg !== undefined) return arg;
  if (!existsSync(CONFIG)) throw new Error(`no ${CONFIG} here: run it in a project, or pass the app file`);
  return CONFIG;
}

export async function load(file: string): Promise<App> {
  const mod = (await import(pathToFileURL(resolve(file)).href)) as { default?: unknown };
  const app = mod.default as App | undefined;
  if (typeof app?.run !== "function") throw new Error(`${file}: the default export must be the app (export default kasbah(config))`);
  if (file.endsWith(CONFIG)) for (const f of PROJECT_FILES.map((f) => join(dirname(resolve(file)), f))) if (existsSync(f)) await import(pathToFileURL(f).href);
  return app;
}

export const IGNORED = /(^|\/)(node_modules|\.git)(\/|$)/;
export const CODE = /\.(ts|mts|js|mjs|cjs|json)$/;

/** A hash of the code files under the app's directory: part of the build id, like Ponder's. */
export function sourceHash(file: string): string {
  const root = dirname(resolve(file));
  const h = createHash("sha256");
  const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => !IGNORED.test(f) && CODE.test(f)).sort();
  for (const f of files) h.update(relative(root, join(root, f))).update("\0").update(readFileSync(join(root, f))).update("\0");
  return h.digest("hex").slice(0, 16);
}
