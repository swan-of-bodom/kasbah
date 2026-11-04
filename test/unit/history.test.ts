import { expect, test } from "vitest";
import {
  type ClassStore,
  classHistory,
  createHistoricalDecoder,
  type KnownClasses,
  storedClassHistory,
} from "../../src/abi/history.ts";
import { type Abi, selector } from "../../src/index.ts";
import { type RpcClient, RpcError } from "../../src/rpc/client.ts";

function fakeContract(deployedAt: number, changes: [number, string][], asked: number[] = []) {
  const rpc = {
    async request(_method: string, params: { block_id: { block_number: number } }) {
      const b = params.block_id.block_number;
      asked.push(b);
      if (b < deployedAt) throw new RpcError("starknet_getClassHashAt", 20, "Contract not found");
      return changes.filter(([at]) => at <= b).at(-1)![1];
    },
  };
  return rpc as unknown as RpcClient;
}

test("finds the deployment and every class change", async () => {
  const changes: [number, string][] = [
    [1_234, "0xa"],
    [1_235, "0xb"],
    [500_000, "0xc"],
    [2_999_999, "0xd"],
  ];
  const spans = await classHistory(fakeContract(1_234, changes), "0x1", 0, 3_000_000);
  expect(spans).toEqual(changes.map(([from, classHash]) => ({ from, classHash })));
});

test("a contract deployed before the range starts at the range start", async () => {
  const spans = await classHistory(
    fakeContract(0, [
      [0, "0xa"],
      [700, "0xb"],
    ]),
    "0x1",
    100,
    1_000,
  );
  expect(spans).toEqual([
    { from: 100, classHash: "0xa" },
    { from: 700, classHash: "0xb" },
  ]);
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

function memoryStore() {
  const histories = new Map<string, KnownClasses>();
  const store: ClassStore = {
    history: async (a) => histories.get(a),
    saveHistory: async (a, k) => void histories.set(a, structuredClone(k)),
    abi: async () => undefined,
    saveAbi: async () => {},
  };
  return { store, histories };
}

test("a stored history is asked again only past the final block it was known through", async () => {
  const changes: [number, string][] = [
    [1_234, "0xa"],
    [500_000, "0xb"],
    [2_400_000, "0xc"],
    [2_999_999, "0xd"],
  ];
  const asked: number[] = [];
  const rpc = fakeContract(1_234, changes, asked);
  const { store, histories } = memoryStore();
  const fresh = (from: number, to: number) =>
    classHistory(fakeContract(1_234, changes), "0x1", from, to);

  // First run: tip 2.5M, final 2.3M: the change at 2.4M is found but not saved.
  expect(await storedClassHistory(rpc, store, "0x1", 0, 2_500_000, 2_300_000)).toEqual(
    await fresh(0, 2_500_000),
  );
  expect(histories.get("0x1")).toEqual({
    from: 0,
    through: 2_300_000,
    spans: [
      { from: 1_234, classHash: "0xa" },
      { from: 500_000, classHash: "0xb" },
    ],
  });

  // Restart: one probe at the new tip; it differs, so only past 2.3M is bisected.
  asked.length = 0;
  expect(await storedClassHistory(rpc, store, "0x1", 0, 3_000_000, 2_999_000)).toEqual(
    await fresh(0, 3_000_000),
  );
  expect(Math.min(...asked)).toBeGreaterThan(2_300_000);
  expect(histories.get("0x1")?.through).toBe(2_999_000);

  // Nothing new: one call. Inside what's known, from a later block: none.
  asked.length = 0;
  expect(await storedClassHistory(rpc, store, "0x1", 0, 2_999_500, 2_999_400)).toEqual(
    await fresh(0, 2_999_500),
  );
  expect(asked).toEqual([2_999_500]);
  asked.length = 0;
  expect(await storedClassHistory(rpc, store, "0x1", 600_000, 2_500_000, 2_999_400)).toEqual(
    await fresh(600_000, 2_500_000),
  );
  expect(asked).toEqual([]);
});

test("a stored history starting after the range asked is recomputed, and one not deployed yet is kept as such", async () => {
  const changes: [number, string][] = [[5_000, "0xa"]];
  const asked: number[] = [];
  const rpc = fakeContract(5_000, changes, asked);
  const { store, histories } = memoryStore();
  expect(await storedClassHistory(rpc, store, "0x1", 1_000, 2_000, 2_000)).toEqual([]);
  expect(histories.get("0x1")).toEqual({ from: 1_000, through: 2_000, spans: [] });
  expect(await storedClassHistory(rpc, store, "0x1", 1_500, 9_000, 9_000)).toEqual([
    { from: 5_000, classHash: "0xa" },
  ]);
  expect(await storedClassHistory(rpc, store, "0x1", 0, 9_000, 9_000)).toEqual([
    { from: 5_000, classHash: "0xa" },
  ]);
  expect(histories.get("0x1")).toEqual({
    from: 0,
    through: 9_000,
    spans: [{ from: 5_000, classHash: "0xa" }],
  });
});
