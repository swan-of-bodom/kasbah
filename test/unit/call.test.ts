import { createServer } from "node:http";
import { expect, test } from "vitest";
import { Codec } from "../../src/abi/codec.ts";
import { compileFunction } from "../../src/abi/functions.ts";
import { CallClient } from "../../src/indexer/client.ts";
import { RpcClient } from "../../src/rpc/client.ts";
import { felt } from "../../src/types/felt.ts";
import cairo0Pair from "../fixtures/cairo0-0.abi.ts";
import ekubo from "../fixtures/ekubo-core.abi.ts";

const abi = [
  {
    type: "struct",
    name: "t::Point",
    members: [
      { name: "x", type: "core::integer::i32" },
      { name: "y", type: "core::integer::u256" },
    ],
  },
  {
    type: "enum",
    name: "t::Side",
    variants: [
      { name: "Left", type: "()" },
      { name: "Right", type: "()" },
    ],
  },
  {
    type: "enum",
    name: "t::Shape",
    variants: [
      { name: "Dot", type: "t::Point" },
      { name: "Line", type: "core::array::Array::<t::Point>" },
      { name: "Empty", type: "()" },
    ],
  },
] as const;

test("every type written then read gives the value back", () => {
  const codec = new Codec(abi);
  const cases: [string, unknown][] = [
    ["core::felt252", 2n ** 250n],
    ["core::integer::u8", 255],
    ["core::integer::i128", -(2n ** 127n)],
    ["core::integer::i32", -7],
    ["core::integer::u256", 2n ** 256n - 1n],
    ["core::integer::u512", 2n ** 300n + 5n],
    ["core::bool", true],
    ["core::starknet::contract_address::ContractAddress", `0x${"0".repeat(60)}abcd`],
    ["core::byte_array::ByteArray", "hello, a string longer than thirty-one bytes 🐫"],
    ["core::byte_array::ByteArray", ""],
    ["core::array::Span::<core::integer::u128>", [1n, 2n, 3n]],
    ["core::option::Option::<core::integer::u16>", 9],
    ["core::option::Option::<core::integer::u16>", null],
    ["core::result::Result::<core::integer::u8, core::felt252>", { err: 4n }],
    ["(core::integer::u8, core::bool)", [3, false]],
    ["t::Point", { x: -1, y: 2n ** 200n }],
    ["t::Side", "Right"],
    [
      "t::Shape",
      {
        variant: "Line",
        value: [
          { x: 1, y: 2n },
          { x: -3, y: 4n },
        ],
      },
    ],
    ["t::Shape", { variant: "Empty", value: undefined }],
  ];
  for (const [type, value] of cases) {
    const out: string[] = [];
    codec.writer(type)(value, out);
    const c = { felts: out, i: 0 };
    expect(codec.reader(type)(c), type).toEqual(value);
    expect(c.i, type).toBe(out.length);
  }
});

test("values that don't fit are refused", () => {
  const codec = new Codec(abi);
  const write = (type: string, v: unknown) => codec.writer(type)(v, []);
  expect(() => write("core::integer::u8", 256)).toThrow("does not fit");
  expect(() => write("core::integer::i8", -129)).toThrow("does not fit");
  expect(() => write("core::felt252", -1n)).toThrow("not a felt");
  expect(() => write("t::Point", { x: 1 })).toThrow("missing y");
  expect(() => write("t::Side", "Up")).toThrow("no variant Up");
});

test("functions: Cairo 1 in interfaces, Cairo 0 with named outputs", () => {
  const liquidity = compileFunction(ekubo, "get_pool_liquidity");
  const key = { token0: "0x1", token1: "0x2", fee: 3n, tick_spacing: 4n, extension: "0x0" };
  expect(liquidity.encode({ pool_key: key })).toEqual(["0x1", "0x2", "0x3", "0x4", "0x0"]);
  expect(liquidity.decode(["0x2a"])).toBe(42n);
  const reserves = compileFunction(cairo0Pair, "getReserves");
  expect(reserves.encode(undefined)).toEqual([]);
  expect(reserves.decode(["0x1", "0x2", "0x3"])).toEqual({
    reserve0: 1n,
    reserve1: 2n,
    blockTimestampLast: 3n,
  });
  expect(() => reserves.decode(["0x1", "0x2", "0x3", "0x4"])).toThrow("left over");
  expect(() => compileFunction(ekubo, "nope")).toThrow("no function nope");
});

test("reads are pinned to the indexed block, final ones cached, recent ones pinned by hash", async () => {
  const seen: unknown[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const calls = [JSON.parse(body)].flat();
      seen.push(...calls.map((c) => c.params.block_id));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          calls.map((c) => {
            const id = c.params.block_id;
            if (id.block_number === 13)
              return { jsonrpc: "2.0", id: c.id, error: { code: 40, message: "Contract error" } };
            return {
              jsonrpc: "2.0",
              id: c.id,
              result: ["0x" + (id.block_number ?? 99).toString(16)],
            };
          }),
        ),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const client = new CallClient(new RpcClient(`http://127.0.0.1:${port}`), {
      isFinal: (b) => b <= 100,
    });
    const key = {
      token0: "0x1",
      token1: "0x2",
      fee: 3n,
      tick_spacing: 4n,
      extension: "0x0",
    } as const;
    const read = (block?: number) =>
      client.read({
        abi: ekubo,
        address: "0xe",
        functionName: "get_pool_liquidity",
        args: { pool_key: key },
        block,
      });

    client.current = { number: 50, hash: "0xh50" };
    expect(await read()).toBe(50n);
    expect(await read()).toBe(50n);
    expect(client.stats).toEqual({ calls: 1, cached: 1 });

    client.current = { number: 150, hash: "0xh150" };
    expect(await read()).toBe(99n);
    expect(await read()).toBe(99n);
    expect(await read(60)).toBe(60n);
    expect(client.stats).toEqual({ calls: 4, cached: 1 });
    expect(seen).toEqual([
      { block_number: 50 },
      { block_hash: "0xh150" },
      { block_hash: "0xh150" },
      { block_number: 60 },
    ]);

    await expect(read(13)).rejects.toThrow("call get_pool_liquidity on 0xe at block 13");
    expect(
      await client.call({
        address: "0xe",
        entrypoint: "get_pool_liquidity",
        calldata: ["0x1", "0x2", "0x3", "0x4", "0x0"],
        block: 50,
      }),
    ).toEqual([felt("0x32")]);
  } finally {
    server.close();
  }
});

// Compile-time only: arguments are checked against the ABI.
async function _typed(client: CallClient) {
  // @ts-expect-error pool_key is required
  await client.read({ abi: ekubo, address: "0xe", functionName: "get_pool_liquidity", args: {} });
  // @ts-expect-error no such function
  await client.read({ abi: ekubo, address: "0xe", functionName: "nope" });
  const r: { reserve0: bigint } = await client.read({
    abi: cairo0Pair,
    address: "0xe",
    functionName: "getReserves",
  });
  return r;
}
