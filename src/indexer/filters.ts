import type { Abi, AbiMember } from "../abi/abi.ts";
import { Codec } from "../abi/codec.ts";
import { abiEvents } from "../abi/events.ts";
import { ConfigError } from "../config/errors.ts";

/** Per event, per argument: the value it must have, or the values it may have. */
export type FilterConfig = Record<string, Record<string, unknown>>;

/**
 * One event's filter: `matches` checks decoded arguments (always applied), and `keys`, when its filtered arguments
 * include fixed-width key members, is the positional `getEvents` filter that fetches only (a superset of) the matches.
 */
export type CompiledFilter = {
  matches: (args: Record<string, unknown>) => boolean;
  keys?: string[][];
};

/** Felts each fixed-width type takes; any other type (arrays, `ByteArray`, structs) ends what keys can filter. */
const WIDTH: Record<string, number> = {
  "core::integer::u256": 2,
  ...Object.fromEntries(
    [
      "core::felt252",
      "felt",
      "core::bool",
      "core::bytes_31::bytes31",
      "core::starknet::contract_address::ContractAddress",
      "core::starknet::class_hash::ClassHash",
      "core::starknet::eth_address::EthAddress",
      ...["u8", "u16", "u32", "u64", "u128", "usize", "i8", "i16", "i32", "i64", "i128"].map(
        (t) => `core::integer::${t}`,
      ),
    ].map((t) => [t, 1]),
  ),
};

function normal(v: unknown): string {
  if (typeof v === "bigint" || typeof v === "number") return `n${BigInt(v)}`;
  if (typeof v === "string" && /^0x[0-9a-f]+$/i.test(v)) return `n${BigInt(v)}`;
  if (typeof v === "boolean") return `b${v}`;
  return `s${String(v)}`;
}

const valuesOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);

/** Compiles a contract's `filter` against its ABI: unknown events, arguments or non-plain types are refused. */
export function compileFilters(
  contract: string,
  abi: Abi,
  filter: FilterConfig | undefined,
): Map<string, CompiledFilter> {
  const out = new Map<string, CompiledFilter>();
  if (filter === undefined) return out;
  const codec = new Codec(abi);
  const events = new Map(abiEvents(abi).map((e) => [e.name, e]));
  for (const [name, args] of Object.entries(filter)) {
    const e = events.get(name);
    if (e === undefined)
      throw new ConfigError(`${contract}: filter on ${name}, not an event of its ABI`);
    const members = new Map([...e.keyMembers, ...e.dataMembers].map((m) => [m.name, m]));
    const allowed = new Map<string, Set<string>>();
    for (const [arg, value] of Object.entries(args)) {
      const m = members.get(arg);
      if (m === undefined)
        throw new ConfigError(`${contract}: filter on ${name}.${arg}, not an argument of it`);
      if (WIDTH[m.type] === undefined)
        throw new ConfigError(
          `${contract}: filter on ${name}.${arg}: only plain values (${m.type} isn't one)`,
        );
      const values = valuesOf(value);
      if (values.length === 0)
        throw new ConfigError(`${contract}: filter on ${name}.${arg}: no value`);
      allowed.set(arg, new Set(values.map(normal)));
    }
    const checks = [...allowed];
    out.set(name, {
      matches: (decoded) => checks.every(([arg, set]) => set.has(normal(decoded[arg]))),
      keys: keysOf(codec, e.selectors, e.keyMembers, args),
    });
  }
  return out;
}

function keysOf(
  codec: Codec,
  selectors: string[],
  keyMembers: AbiMember[],
  args: Record<string, unknown>,
): string[][] | undefined {
  const keys: string[][] = selectors.map((s) => [s]);
  let filtered = false;
  for (const m of keyMembers) {
    const width = WIDTH[m.type];
    if (width === undefined) break;
    const value = args[m.name];
    if (value === undefined) {
      for (let i = 0; i < width; i++) keys.push([]);
      continue;
    }
    const positions: Set<string>[] = Array.from({ length: width }, () => new Set());
    for (const v of valuesOf(value)) {
      const felts: string[] = [];
      codec.writer(m.type)(v, felts);
      for (const [i, f] of felts.entries()) positions[i]!.add(`0x${BigInt(f).toString(16)}`);
    }
    for (const p of positions) keys.push([...p]);
    filtered = true;
  }
  if (!filtered) return undefined;
  while (keys.at(-1)?.length === 0) keys.pop();
  return keys;
}
