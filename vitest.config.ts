import { createRequire } from "node:module";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // graphql ships CommonJS and ESM: Vitest would give kasbah's code one and Yoga the other, which graphql refuses.
    alias: { graphql: createRequire(import.meta.url).resolve("graphql") },
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
