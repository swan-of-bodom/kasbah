import { expect, test } from "vitest";
import type { Config } from "../../src/config/app.ts";
import { DEFAULTS, resolveConfig } from "../../src/config/resolve.ts";

const base: Config = { rpc: "https://node/rpc", database: "", contracts: {}, tables: {} };

test("resolveConfig: every left-out field gets its default", () => {
  expect(resolveConfig(base)).toMatchObject({
    schema: DEFAULTS.schema,
    concurrency: DEFAULTS.concurrency,
    reorgWindow: DEFAULTS.reorgWindow,
    pollMs: DEFAULTS.pollMs,
    ws: undefined,
    cache: undefined,
    blocks: {},
  });
});

test("resolveConfig: `ws: true` is the RPC URL's socket, and `cache: true` keeps the default calls", () => {
  const r = resolveConfig({ ...base, ws: true, cache: true });
  expect(r.ws).toBe("wss://node/rpc");
  expect(r.cache).toEqual({ maxCalls: DEFAULTS.maxCalls });
  expect(resolveConfig({ ...base, cache: { maxCalls: 5 } }).cache).toEqual({ maxCalls: 5 });
});
