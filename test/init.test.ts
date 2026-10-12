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

const files = generate({ dir: "/x/pools", rpc: "http://rpc", database: "postgres://db", name: "Pool", address: "0x1", abi, startBlock: 7, events: ["Moved"], timestamps: false, dependency: "^0.0.0" });

test("one table per event, arguments as typed columns, structs as jsonb", () => {
  expect(files["schema.ts"]).toContain(`export const moved = pgTable("moved", {`);
  expect(files["schema.ts"]).toMatch(/block_: bignum\(\)\.notNull\(\),\n {2}who: hex\(\)\.notNull\(\),\n {2}key: jsonb\(\),\n {2}ok: boolean\(\)\.notNull\(\),/);
  expect(files["schema.ts"]).not.toContain("timestamp");
  expect(files["app.ts"]).toContain(`app.on("Pool:Moved"`);
  expect(files["app.ts"]).toContain("block_: event.args.block,");
  expect(files["app.ts"]).toContain("key: plain(event.args.key),");
  expect(files["app.ts"]).toContain(`Pool: { abi: poolAbi, address: "0x1", startBlock: 7 },`);
  expect(files["app.ts"]).toContain(`schema: "pools",`);
});

test("secrets only in .env, which git ignores", () => {
  expect(files[".env"]).toBe("KASBAH_RPC_URL=http://rpc\nDATABASE_URL=postgres://db\n");
  expect(files[".gitignore"]).toContain(".env");
  expect(files[".dockerignore"]).toContain(".env");
  for (const [path, content] of Object.entries(files)) if (path !== ".env") expect(content).not.toContain("http://rpc");
});
