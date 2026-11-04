import { createRequire } from "node:module";
import { resolve } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // graphql ships CommonJS and ESM: Vitest would give kasbah's code one and Yoga the other, which graphql refuses.
    alias: [
      { find: /^graphql$/, replacement: createRequire(import.meta.url).resolve("graphql") },
      // Templates import kasbah as an app does: in this repo, its sources.
      { find: /^kasbah$/, replacement: resolve(import.meta.dirname, "src/index.ts") },
      { find: /^kasbah\/api$/, replacement: resolve(import.meta.dirname, "src/api/index.ts") },
    ],
  },
  test: {
    // Worktrees of this repo (an editor's agents) hold copies of the tests.
    exclude: [...configDefaults.exclude, ".claude/**"],
    globalSetup: ["test/teardown.ts"],
    // Every e2e run starts a fetch thread (a V8 instance and a Postgres connection of its own), and the files run in
    // parallel: tests of ~1 s alone took past the default 5 s with all of them running, here and on CI's 4 cores.
    testTimeout: 30_000,
  },
});
