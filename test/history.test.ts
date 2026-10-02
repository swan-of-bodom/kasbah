import { expect, test } from "vitest";
import { classHistory, createHistoricalDecoder } from "../src/abi/history.ts";
import { type Abi, selector } from "../src/index.ts";
import { RpcError, type RpcClient } from "../src/rpc/client.ts";

function fakeContract(deployedAt: number, changes: [number, string][]) {
  const rpc = {
    async request(_method: string, params: { block_id: { block_number: number } }) {
      const b = params.block_id.block_number;
      if (b < deployedAt) throw new RpcError("starknet_getClassHashAt", 20, "Contract not found");
      return changes.filter(([at]) => at <= b).at(-1)![1];
    },
  };
  return rpc as unknown as RpcClient;
}

test("finds the deployment and every class change", async () => {
  const changes: [number, string][] = [[1_234, "0xa"], [1_235, "0xb"], [500_000, "0xc"], [2_999_999, "0xd"]];
  const spans = await classHistory(fakeContract(1_234, changes), "0x1", 0, 3_000_000);
  expect(spans).toEqual(changes.map(([from, classHash]) => ({ from, classHash })));
});

test("a contract deployed before the range starts at the range start", async () => {
  const spans = await classHistory(fakeContract(0, [[0, "0xa"], [700, "0xb"]]), "0x1", 100, 1_000);
  expect(spans).toEqual([{ from: 100, classHash: "0xa" }, { from: 700, classHash: "0xb" }]);
});

test("each block decodes with the ABI active then", () => {
  const abi = (fields: string[]): Abi => [
    { type: "event", name: "Ping", keys: [], data: fields.map((name) => ({ name, type: "felt" })) },
  ];
  const decode = createHistoricalDecoder([
    { from: 10, classHash: "0xa", abi: abi(["a"]) },
    { from: 20, classHash: "0xb", abi: abi(["a", "b"]) },
  ]);
  const ping = [selector("Ping")];
  expect(decode(9, ping, ["0x1"])).toBeUndefined();
  expect(decode(19, ping, ["0x1"])).toEqual({ name: "Ping", args: { a: 1n } });
  expect(decode(20, ping, ["0x1", "0x2"])).toEqual({ name: "Ping", args: { a: 1n, b: 2n } });
  expect(() => decode(25, ping, ["0x1"])).toThrow();
});
