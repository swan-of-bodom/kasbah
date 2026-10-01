import { readFileSync } from "node:fs";
import { CairoCustomEnum, CairoOption, CallData, events, hash } from "starknet";
import { describe, expect, test } from "vitest";
import { type Abi, abiEvents, createDecoder, DecodeError, selector } from "../src/index.ts";

type EmittedEvent = { keys: string[]; data: string[]; from_address: string };

const fixture = <T>(file: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8")) as T;

const FIXTURES = {
  "ekubo-core": {
    "OwnedEvent.OwnershipTransferred": 5,
    Swapped: 382,
    LoadedBalance: 7,
    SavedBalance: 9,
    PositionFeesCollected: 1,
    PositionUpdated: 1,
  },
  strk: { Transfer: 91, Approval: 18 },
  "cairo0-0": { Transfer: 43, Sync: 72, Mint: 15, Swap: 49, Approval: 14, Burn: 7 },
  "cairo0-1": { Approval: 35, Transfer: 92 },
} as const;

/** Reduces both decoders' outputs to one shape: integers and hex as bigint, u256 `{low, high}` folded. */
function normalize(v: unknown): unknown {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string") return v.startsWith("0x") ? BigInt(v) : v;
  if (typeof v === "boolean" || v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(normalize);
  if (v instanceof CairoOption) return v.isSome() ? normalize(v.unwrap()) : null;
  if (v instanceof CairoCustomEnum) {
    const value = v.unwrap();
    const empty = value === undefined || (typeof value === "object" && value !== null && Object.keys(value).length === 0);
    return empty ? v.activeVariant() : { variant: v.activeVariant(), value: normalize(value) };
  }
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 2 && "low" in o && "high" in o) return BigInt(o.low as bigint) + (BigInt(o.high as bigint) << 128n);
  return Object.fromEntries(keys.map((k) => [k, normalize(o[k])]));
}

describe("selector", () => {
  test.each(["Transfer", "Swapped", "OwnedEvent", "ERC20Event", "a", ""])("sn_keccak(%j) matches starknet.js", (name) => {
    expect(BigInt(selector(name))).toBe(BigInt(hash.getSelectorFromName(name)));
  });
});

describe.each(Object.entries(FIXTURES))("%s", (name, expectedCounts) => {
  const abi = fixture<Abi>(`${name}.abi.json`);
  const emitted = fixture<EmittedEvent[]>(`${name}.events.json`);
  const decode = createDecoder(abi);

  test("every event decodes, using exactly its keys and data", () => {
    const counts: Record<string, number> = {};
    for (const e of emitted) {
      const decoded = decode(e.keys, e.data);
      expect(decoded, `${e.keys[0]} not recognized`).toBeDefined();
      counts[decoded!.name] = (counts[decoded!.name] ?? 0) + 1;
    }
    expect(counts).toEqual(expectedCounts);
  });

  test("args match starknet.js on every event", () => {
    const parsed = events.parseEvents(
      emitted as never,
      events.getAbiEvents(abi as never),
      CallData.getAbiStruct(abi as never),
      CallData.getAbiEnum(abi as never),
      new CallData(abi as never).parser,
    );
    expect(parsed).toHaveLength(emitted.length);
    for (const [i, e] of emitted.entries()) {
      const ours = decode(e.keys, e.data)!;
      const theirs = parsed[i] as Record<string, unknown>;
      const key = Object.keys(theirs).find((k) => !["block_hash", "block_number", "transaction_hash", "transaction_index", "event_index"].includes(k))!;
      expect(normalize(ours.args), `event ${i} (${ours.name})`).toEqual(normalize(theirs[key]));
    }
  });

  test("a felt too many or too few is an error, not a silent misread", () => {
    const e = emitted[0]!;
    expect(() => decode(e.keys, [...e.data, "0x1"])).toThrow(DecodeError);
    expect(() => decode(e.keys, e.data.slice(0, -1))).toThrow(DecodeError);
  });
});

test("unknown selectors return undefined", () => {
  const decode = createDecoder(fixture<Abi>("strk.abi.json"));
  expect(decode([selector("NotAnEvent")], [])).toBeUndefined();
  expect(decode([], [])).toBeUndefined();
});

test("Ekubo: flat variants add no selector, nested ones do", () => {
  const defs = abiEvents(fixture<Abi>("ekubo-core.abi.json"));
  const by = Object.fromEntries(defs.map((d) => [d.name, d.selectors]));
  expect(by.ClassHashReplaced).toEqual([selector("ClassHashReplaced")]);
  expect(by["OwnedEvent.OwnershipTransferred"]).toEqual([selector("OwnedEvent"), selector("OwnershipTransferred")]);
  expect(by.Swapped).toEqual([selector("Swapped")]);
});

test("STRK Transfer reads from/to from keys", () => {
  const def = abiEvents(fixture<Abi>("strk.abi.json")).find((d) => d.name === "Transfer")!;
  expect(def.keyMembers.map((m) => m.name)).toEqual(["from", "to"]);
  expect(def.dataMembers.map((m) => m.name)).toEqual(["value"]);
});

describe("codec", () => {
  const abi = [
    {
      type: "event",
      name: "t::E",
      kind: "enum",
      variants: [{ name: "Values", type: "t::Values", kind: "nested" }],
    },
    {
      type: "event",
      name: "t::Values",
      kind: "struct",
      members: [
        { name: "text", type: "core::byte_array::ByteArray", kind: "data" },
        { name: "neg32", type: "core::integer::i32", kind: "data" },
        { name: "neg128", type: "core::integer::i128", kind: "data" },
        { name: "some", type: "core::option::Option::<core::integer::u8>", kind: "data" },
        { name: "none", type: "core::option::Option::<core::integer::u8>", kind: "data" },
        { name: "err", type: "core::result::Result::<core::array::Array::<core::felt252>, core::felt252>", kind: "data" },
        { name: "pair", type: "(core::bool, core::integer::u64)", kind: "data" },
        { name: "eth", type: "core::starknet::eth_address::EthAddress", kind: "data" },
        { name: "big", type: "core::integer::u512", kind: "data" },
        { name: "color", type: "t::Color", kind: "data" },
        { name: "shape", type: "t::Shape", kind: "data" },
      ],
    },
    { type: "enum", name: "t::Color", variants: [{ name: "Red", type: "()" }, { name: "Blue", type: "()" }] },
    { type: "enum", name: "t::Shape", variants: [{ name: "Dot", type: "()" }, { name: "Circle", type: "core::integer::u32" }] },
  ] as const;
  const P = 2n ** 251n + 17n * 2n ** 192n + 1n;
  const felt = (v: bigint) => `0x${v.toString(16)}`;
  const text = "a string longer than thirty-one bytes, with ü";
  const bytes = new TextEncoder().encode(text);
  const words = [bytes.slice(0, 31), bytes.slice(31)];
  const word = (b: Uint8Array) => felt(b.reduce((acc, x) => (acc << 8n) | BigInt(x), 0n));

  test("ByteArray, signed ints, Option, Result, tuples, EthAddress, u512, enums", () => {
    const data = [
      "0x1", word(words[0]!), word(words[1]!), felt(BigInt(words[1]!.length)),
      felt(P - 5n),
      felt(P - 2n ** 100n),
      "0x0", "0x7",
      "0x1",
      "0x1", "0x2a",
      "0x1", "0x10",
      "0xabc",
      "0x1", "0x0", "0x0", "0x2",
      "0x1",
      "0x1", "0x9",
    ];
    const decoded = createDecoder(abi)([selector("Values")], data);
    expect(decoded).toEqual({
      name: "Values",
      args: {
        text,
        neg32: -5,
        neg128: -(2n ** 100n),
        some: 7,
        none: null,
        err: { err: 42n },
        pair: [true, 16n],
        eth: `0x${"abc".padStart(40, "0")}`,
        big: 1n + (2n << 384n),
        color: "Blue",
        shape: { variant: "Circle", value: 9 },
      },
    });
  });

  test("Cairo 0: x_len + x: felt* become one array, named tuples become objects", () => {
    const cairo0 = [
      {
        type: "event",
        name: "Batch",
        keys: [],
        data: [
          { name: "ids_len", type: "felt" },
          { name: "ids", type: "felt*" },
          { name: "point", type: "(x : felt, y : felt)" },
          { name: "amount", type: "Uint256" },
        ],
      },
      { type: "struct", name: "Uint256", size: 2, members: [{ name: "low", offset: 0, type: "felt" }, { name: "high", offset: 1, type: "felt" }] },
    ] as const;
    const decoded = createDecoder(cairo0)([selector("Batch")], ["0x2", "0x5", "0x6", "0x1", "0x2", "0x3", "0x1"]);
    expect(decoded).toEqual({ name: "Batch", args: { ids: [5n, 6n], point: { x: 1n, y: 2n }, amount: 3n + (1n << 128n) } });
  });
});
