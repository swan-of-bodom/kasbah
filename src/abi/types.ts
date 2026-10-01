import type { Abi, AbiMember } from "./abi.ts";

// Type-level mirror of codec.ts and events.ts: every rule here has a runtime twin, tested on real ABIs.

type Simplify<T> = { [K in keyof T]: T[K] } & {};

type Hex = `0x${string}`;

type SmallInt = "core::integer::u8" | "core::integer::u16" | "core::integer::u32" | "core::integer::usize"
  | "core::integer::i8" | "core::integer::i16" | "core::integer::i32";
type BigInteger = "core::felt252" | "felt" | "core::integer::u64" | "core::integer::u128" | "core::integer::u256"
  | "core::integer::u512" | "core::integer::i64" | "core::integer::i128";
type HexTypes = "core::starknet::contract_address::ContractAddress" | "core::starknet::class_hash::ClassHash"
  | "core::starknet::storage_access::StorageAddress" | "core::starknet::eth_address::EthAddress"
  | "core::bytes_31::bytes31";

type Count<S extends string, C extends string, N extends unknown[] = []> =
  S extends `${string}${C}${infer Rest}` ? Count<Rest, C, [...N, 0]> : N["length"];

type Balanced<S extends string> = Count<S, "<"> extends Count<S, ">">
  ? Count<S, "("> extends Count<S, ")"> ? true : false
  : false;

/** `A, B<C, D>, (E, F)` → `["A", "B<C, D>", "(E, F)"]`. Mirrors `splitTopLevel`. */
export type SplitTopLevel<S extends string, Acc extends string = "", Out extends string[] = []> =
  S extends `${infer Head},${infer Rest}`
    ? Balanced<`${Acc}${Head}`> extends true
      ? SplitTopLevel<Rest, "", [...Out, Trim<`${Acc}${Head}`>]>
      : SplitTopLevel<Rest, `${Acc}${Head},`, Out>
    : Trim<`${Acc}${S}`> extends "" ? Out : [...Out, Trim<`${Acc}${S}`>];

type Trim<S extends string> = S extends ` ${infer R}` ? Trim<R> : S extends `${infer R} ` ? Trim<R> : S;

/** Cairo 0 `(x : felt, y : felt)`: every part has `:` and none has the Cairo 1 path separator `::`. */
type IsNamed<Parts extends string[]> = [Extract<Parts[number], `${string}::${string}`>] extends [never]
  ? Parts extends [] ? false : Parts[number] extends `${string}:${string}` ? true : false
  : false;

type NamedTuple<TAbi extends Abi, Parts extends string[]> = Simplify<{
  [P in Parts[number] as P extends `${infer N}:${string}` ? Trim<N> : never]:
    P extends `${string}:${infer T}` ? TypeOf<TAbi, Trim<T>> : never;
}>;

type Tuple<TAbi extends Abi, Parts extends string[]> = { [I in keyof Parts]: TypeOf<TAbi, Parts[I]> };

type StructItem<TAbi extends Abi, N extends string> = Extract<TAbi[number], { type: "struct"; name: N }>;
type EnumItem<TAbi extends Abi, N extends string> = Extract<TAbi[number], { type: "enum"; name: N }>;

type EnumOf<TAbi extends Abi, V extends readonly AbiMember[]> =
  V[number]["type"] extends "()"
    ? V[number]["name"]
    : V[number] extends infer Variant extends AbiMember
      ? { variant: Variant["name"]; value: TypeOf<TAbi, Variant["type"]> }
      : never;

/** The TypeScript type `createDecoder` produces for an ABI type string. */
export type TypeOf<TAbi extends Abi, Raw extends string> =
  Raw extends `@${infer T}` ? TypeOf<TAbi, T>
  : Raw extends "core::bool" ? boolean
  : Raw extends SmallInt ? number
  : Raw extends BigInteger ? bigint
  : Raw extends HexTypes ? Hex
  : Raw extends "core::byte_array::ByteArray" ? string
  : Raw extends "()" ? undefined
  : Raw extends `core::array::Array::<${infer I}>` | `core::array::Span::<${infer I}>` ? TypeOf<TAbi, I>[]
  : Raw extends `core::option::Option::<${infer I}>` ? TypeOf<TAbi, I> | null
  : Raw extends `core::result::Result::<${infer R}>`
    ? SplitTopLevel<R> extends [infer Ok extends string, infer Err extends string]
      ? { ok: TypeOf<TAbi, Ok> } | { err: TypeOf<TAbi, Err> }
      : unknown
  : Raw extends `core::zeroable::NonZero::<${infer I}>` ? TypeOf<TAbi, I>
  : Raw extends `core::internal::bounded_int::BoundedInt::<${string}>` ? bigint
  : Raw extends `(${infer Inner})`
    ? SplitTopLevel<Inner> extends infer Parts extends string[]
      ? IsNamed<Parts> extends true ? NamedTuple<TAbi, Parts> : Tuple<TAbi, Parts>
      : never
  : Raw extends "Uint256" ? bigint
  : StructItem<TAbi, Raw> extends { members: infer M extends readonly AbiMember[] } ? MembersOf<TAbi, M>
  : EnumItem<TAbi, Raw> extends { variants: infer V extends readonly AbiMember[] } ? EnumOf<TAbi, V>
  : unknown;

type PointerName<M extends readonly AbiMember[]> = Extract<M[number], { type: `${string}*` }>["name"];

/** An object of members. Cairo 0 `x_len: felt` + `x: T*` becomes `x: T[]`. Mirrors `Codec.members`. */
export type MembersOf<TAbi extends Abi, M extends readonly AbiMember[]> = Simplify<{
  [K in M[number] as K["name"] extends `${PointerName<M>}_len` ? never : K["name"]]:
    K["type"] extends `${infer I}*` ? TypeOf<TAbi, I>[] : TypeOf<TAbi, K["type"]>;
}>;

// Event leaves: [name, members] pairs, mirroring `abiEvents`.

type EventItem<TAbi extends Abi, N extends string> = Extract<TAbi[number], { type: "event"; name: N }>;

type Join<P extends string, N extends string> = P extends "" ? N : `${P}.${N}`;

type VariantLeaves<TAbi extends Abi, V, P extends string> =
  V extends { name: infer N extends string; type: infer T extends string; kind: infer K }
    ? EventItem<TAbi, T> extends infer Inner
      ? K extends "flat"
        ? Inner extends { kind: "enum" } ? EnumLeaves<TAbi, Inner, P> : never
        : Inner extends { kind: "enum" } ? EnumLeaves<TAbi, Inner, Join<P, N>>
        : Inner extends { kind: "struct"; members: infer M extends readonly AbiMember[] }
          ? { name: Join<P, N>; members: M }
          : never
      : never
    : never;

type EnumLeaves<TAbi extends Abi, E, P extends string> =
  E extends { variants: infer V extends readonly unknown[] } ? VariantLeaves<TAbi, V[number], P> : never;

type Referenced<TAbi extends Abi> =
  Extract<TAbi[number], { type: "event"; kind: "enum" }> extends infer E
    ? E extends { variants: infer V extends readonly { type: string }[] } ? V[number]["type"] : never
    : never;

type RootEnums<TAbi extends Abi> = Exclude<
  Extract<TAbi[number], { type: "event"; kind: "enum" }>,
  { name: Referenced<TAbi> }
>;

type LastSegment<S extends string> = S extends `${string}::${infer R}` ? LastSegment<R> : S;

type Leaves<TAbi extends Abi> =
  | EnumLeaves<TAbi, RootEnums<TAbi>, "">
  | (Extract<TAbi[number], { type: "event"; keys: readonly AbiMember[]; data: readonly AbiMember[] }> extends infer E
    ? E extends { name: infer N extends string; keys: infer K extends readonly AbiMember[]; data: infer D extends readonly AbiMember[] }
      ? { name: N; members: readonly [...K, ...D] }
      : never
    : never)
  | (Extract<TAbi[number], { type: "event"; inputs: readonly AbiMember[] }> extends infer E
    ? E extends { name: infer N extends string; inputs: infer I extends readonly AbiMember[] }
      ? { name: LastSegment<N>; members: I }
      : never
    : never);

/** Names of every event the ABI can emit, as `createDecoder` reports them. */
export type EventName<TAbi extends Abi> = Leaves<TAbi>["name"];

/** Decoded arguments of one event. */
export type EventArgs<TAbi extends Abi, N extends EventName<TAbi>> =
  Extract<Leaves<TAbi>, { name: N }> extends { members: infer M extends readonly AbiMember[] }
    ? MembersOf<TAbi, M>
    : never;

/** What `createDecoder` returns: a union over the ABI's events, discriminated by `name`. */
export type DecodedEvent<TAbi extends Abi> = EventName<TAbi> extends infer N
  ? N extends EventName<TAbi> ? { name: N; args: EventArgs<TAbi, N> } : never
  : never;
