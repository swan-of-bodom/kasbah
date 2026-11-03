import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["test/teardown.ts"],
    // Every e2e run starts a fetch thread (a V8 instance and a Postgres connection of its own), and the files run in
    // parallel: tests of ~1 s alone took past the default 5 s with all of them running, here and on CI's 4 cores.
    testTimeout: 30_000,
  },
});
