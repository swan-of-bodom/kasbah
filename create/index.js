#!/usr/bin/env node
// `pnpm create kasbah [dir] [flags]` is `kasbah init [dir] [flags]`.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const root = dirname(createRequire(import.meta.url).resolve("kasbah/package.json"));
const r = spawnSync(process.execPath, [join(root, "dist/cli/main.js"), "init", ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
