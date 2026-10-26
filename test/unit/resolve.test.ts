import { expect, test } from "vitest";
import type { Config } from "../../src/config/app.ts";
import { checkNetwork, NETWORKS, networkName } from "../../src/config/network.ts";
import { DEFAULTS, resolveConfig, schemaName } from "../../src/config/resolve.ts";

const base: Config = {
  rpc: "https://node/rpc",
  database: "postgres://db",
  contracts: {},
  tables: {},
};

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

test("resolveConfig: the environment wins over the config, so one config deploys anywhere", () => {
  const config: Config = {
    ...base,
    database: undefined,
    schema: "app",
    api: { port: 1, host: "a" },
  };
  const env = {
    DATABASE_URL: "postgres://env",
    DATABASE_SCHEMA: "app_v2",
    PORT: "8080",
    API_HOST: "0.0.0.0",
  };
  expect(resolveConfig(config, env)).toMatchObject({
    database: "postgres://env",
    schema: "app_v2",
    api: { port: 8080, host: "0.0.0.0" },
  });
  expect(resolveConfig({ ...config, database: "postgres://db" }, {})).toMatchObject({
    schema: "app",
    api: { port: 1, host: "a" },
  });
  expect(resolveConfig({ ...base, api: {} }, {}).api).toEqual({
    port: DEFAULTS.port,
    host: undefined,
  });
  expect(resolveConfig({ ...base, api: false }, { PORT: "1" }).api).toBeUndefined();
  expect(() => resolveConfig(config, {})).toThrow("no database: set DATABASE_URL");
  expect(() => resolveConfig({ ...base, tables: undefined }, {})).toThrow("no tables");
  expect(() => resolveConfig({ ...base, api: {} }, { PORT: "http" })).toThrow("not a port");
});

test("schemaName: a project directory's name as a Postgres schema", () => {
  expect(schemaName("my-indexer")).toBe("my_indexer");
  expect(schemaName("myIndexer")).toBe("my_indexer");
  expect(schemaName("Ekubo Pools v2")).toBe("ekubo_pools_v2");
  expect(schemaName("2024-app")).toBe("_2024_app");
  expect(schemaName("---")).toBe(DEFAULTS.schema);
});

test("network: names from chain ids, and an RPC on another chain is refused", () => {
  expect(networkName(NETWORKS.mainnet)).toBe("mainnet");
  expect(networkName("0x534e5f5345504f4c4941")).toBe("sepolia");
  expect(networkName("0x534e5f444556")).toBe("SN_DEV");
  expect(() => checkNetwork("mainnet", NETWORKS.mainnet)).not.toThrow();
  expect(() => checkNetwork("mainnet", NETWORKS.sepolia)).toThrow(
    "network is mainnet but the RPC is on sepolia",
  );
});

test('resolveConfig: `finality: "l1"` has no window to set', () => {
  expect(resolveConfig({ ...base, finality: "l1" }, {}).finality).toBe("l1");
  expect(() => resolveConfig({ ...base, finality: "l1", reorgWindow: 10 }, {})).toThrow(
    "L1 finality has no window",
  );
});

test("resolveConfig: `preConfirmed` needs the API", () => {
  expect(() => resolveConfig({ ...base, preConfirmed: true }, {})).toThrow("the API, which is off");
  expect(resolveConfig({ ...base, preConfirmed: true, api: {} }, {}).preConfirmed).toBe(true);
});
