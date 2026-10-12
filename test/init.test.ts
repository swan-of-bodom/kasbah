import { expect, test } from "vitest";
import type { Abi } from "../src/abi/abi.ts";
import { generate } from "../src/init.ts";

const abi = [
  { type: "struct", name: "x::Key", members: [{ name: "a", type: "core::felt252" }] },
  { type: "event", name: "x::Pool::Moved", kind: "struct", members: [
    { name: "block", type: "core::integer::u64", kind: "key" },
    { name: "who", type: "core::starknet::contract_address::ContractAddress", kind: "data" },
    { name: "key", type: "x::Key", kind: "data" },
    { name: "ok", type: "core::bool", kind: "data" },
  ] },
  { type: "event", name: "x::Pool::Event", kind: "enum", variants: [{ name: "Moved", type: "x::Pool::Moved", kind: "nested" }] },
] as const satisfies Abi;

const files = generate({ dir: "/x/pools", rpc: "http://rpc", database: "postgres://db", name: "Pool", address: "0x1", abi, startBlock: 7, events: ["Moved"], timestamps: false, ws: true, dependency: "^0.0.0" });

test("the layout: config, schema, ABI, handlers, routes", () => {
  expect(Object.keys(files).slice(0, 5)).toEqual(["kasbah.config.ts", "kasbah.schema.ts", "abis/Pool.ts", "src/index.ts", "src/api/index.ts"]);
  expect(files["kasbah.config.ts"]).toContain(`Pool: { abi: poolAbi, address: "0x1", startBlock: 7 },`);
  expect(files["kasbah.config.ts"]).toContain(`import poolAbi from "./abis/Pool.ts";`);
  expect(files["kasbah.config.ts"]).toContain("  ws: true,\n");
  expect(files["kasbah.config.ts"]).toContain(`schema: "pools",`);
  expect(files["src/index.ts"]).toContain(`import app from "../kasbah.config.ts";`);
  expect(files["src/api/index.ts"]).toContain(`app.get("/moved/latest"`);
  expect(JSON.parse(files["package.json"]!).scripts.dev).toBe("kasbah dev");
});

test("one table per event, arguments as typed columns, structs as jsonb", () => {
  expect(files["kasbah.schema.ts"]).toContain(`export const moved = pgTable("moved", {`);
  expect(files["kasbah.schema.ts"]).toMatch(/block_: bignum\(\)\.notNull\(\),\n {2}who: hex\(\)\.notNull\(\),\n {2}key: jsonb\(\),\n {2}ok: boolean\(\)\.notNull\(\),/);
  expect(files["kasbah.schema.ts"]).not.toContain("timestamp");
  expect(files["src/index.ts"]).toContain(`app.on("Pool:Moved"`);
  expect(files["src/index.ts"]).toContain("block_: event.args.block,");
  expect(files["src/index.ts"]).toContain("key: plain(event.args.key),");
});

test("secrets only in .env, which git and Docker ignore; .env.example has the names", () => {
  expect(files[".env"]).toBe("KASBAH_RPC_URL=http://rpc\nDATABASE_URL=postgres://db\n");
  expect(files[".env.example"]).toMatch(/^KASBAH_RPC_URL=https:\/\/.*<key>\n# DATABASE_URL=/);
  expect(files[".gitignore"]).toContain(".env\n");
  expect(files[".dockerignore"]).toContain(".env\n");
  for (const [path, content] of Object.entries(files)) if (path !== ".env") expect(content).not.toContain("http://rpc");
});
