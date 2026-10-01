import type { Abi, AbiEnum, AbiMember, AbiStruct } from "./abi.ts";

/** Reads felts from one array (`keys` or `data`) with a moving index. */
export type Cursor = { felts: readonly string[]; i: number };

/** Decodes one value from a cursor. Built once per ABI type, run per event. */
export type Reader = (c: Cursor) => unknown;

const P = 2n ** 251n + 17n * 2n ** 192n + 1n;
const HALF_P = P / 2n;
const U128 = 128n;
const utf8 = new TextDecoder();

export class DecodeError extends Error {}

function next(c: Cursor): string {
  const felt = c.felts[c.i++];
  if (felt === undefined) throw new DecodeError("ran out of felts");
  return felt;
}

const big: Reader = (c) => BigInt(next(c));
const small: Reader = (c) => Number(next(c));
const bool: Reader = (c) => next(c) !== "0x0";
const hex: Reader = (c) => next(c);

const signed = (asNumber: boolean): Reader => (c) => {
  const v = BigInt(next(c));
  const s = v > HALF_P ? v - P : v;
  return asNumber ? Number(s) : s;
};

const pad = (width: number): Reader => (c) => `0x${next(c).slice(2).padStart(width, "0")}`;

const u256: Reader = (c) => {
  const low = BigInt(next(c));
  return low + (BigInt(next(c)) << U128);
};

const u512: Reader = (c) => {
  let v = 0n;
  for (let limb = 0n; limb < 4n; limb++) v += BigInt(next(c)) << (U128 * limb);
  return v;
};

function wordBytes(word: bigint, length: number, out: number[]) {
  for (let i = length - 1; i >= 0; i--) out.push(Number((word >> BigInt(i * 8)) & 0xffn));
}

const byteArray: Reader = (c) => {
  const words = Number(next(c));
  const bytes: number[] = [];
  for (let w = 0; w < words; w++) wordBytes(BigInt(next(c)), 31, bytes);
  const pending = BigInt(next(c));
  wordBytes(pending, Number(next(c)), bytes);
  return utf8.decode(new Uint8Array(bytes));
};

const unit: Reader = () => undefined;

const array = (item: Reader): Reader => (c) => {
  const length = Number(next(c));
  const out = new Array<unknown>(length);
  for (let i = 0; i < length; i++) out[i] = item(c);
  return out;
};

const option = (inner: Reader): Reader => (c) => (next(c) === "0x0" ? inner(c) : null);

const result = (ok: Reader, err: Reader): Reader => (c) =>
  next(c) === "0x0" ? { ok: ok(c) } : { err: err(c) };

const tuple = (items: Reader[]): Reader => (c) => items.map((r) => r(c));

const PRIMITIVES: Record<string, Reader> = {
  "core::felt252": big,
  felt: big,
  "core::bool": bool,
  "core::integer::u8": small,
  "core::integer::u16": small,
  "core::integer::u32": small,
  "core::integer::usize": small,
  "core::integer::u64": big,
  "core::integer::u128": big,
  "core::integer::u256": u256,
  "core::integer::u512": u512,
  "core::integer::i8": signed(true),
  "core::integer::i16": signed(true),
  "core::integer::i32": signed(true),
  "core::integer::i64": signed(false),
  "core::integer::i128": signed(false),
  "core::starknet::contract_address::ContractAddress": pad(64),
  "core::starknet::class_hash::ClassHash": pad(64),
  "core::starknet::storage_access::StorageAddress": pad(64),
  "core::starknet::eth_address::EthAddress": pad(40),
  "core::bytes_31::bytes31": hex,
  "core::byte_array::ByteArray": byteArray,
  "()": unit,
};

/** Splits `A, B<C, D>, (E, F)` on top-level commas. */
export function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "<" || ch === "(") depth++;
    else if (ch === ">" || ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = s.slice(start).trim();
  if (last !== "") parts.push(last);
  return parts;
}

function generic(type: string, prefix: string): string | undefined {
  return type.startsWith(`${prefix}::<`) && type.endsWith(">") ? type.slice(prefix.length + 3, -1) : undefined;
}

/** Compiles ABI type strings into readers, memoized per ABI. Cairo 0 and Cairo 1 type syntax share one namespace. */
export class Codec {
  readonly #structs = new Map<string, AbiStruct>();
  readonly #enums = new Map<string, AbiEnum>();
  readonly #readers = new Map<string, Reader>();

  constructor(abi: Abi) {
    for (const item of abi) {
      if (item.type === "struct") this.#structs.set(item.name, item);
      else if (item.type === "enum") this.#enums.set(item.name, item);
    }
  }

  reader(type: string): Reader {
    let r = this.#readers.get(type);
    if (r === undefined) {
      r = this.#compile(type);
      this.#readers.set(type, r);
    }
    return r;
  }

  /** Reader for a member list, producing an object. Cairo 0 `x_len` + `x: T*` pairs become one array `x`. */
  members(members: readonly AbiMember[]): Reader {
    const fields: { name: string; read: Reader; pointer: boolean; hidden: boolean }[] = [];
    for (const [i, m] of members.entries()) {
      const pointer = m.type.endsWith("*");
      const nextMember = members[i + 1];
      const hidden = nextMember !== undefined && nextMember.type.endsWith("*") && m.name === `${nextMember.name}_len`;
      fields.push({ name: m.name, read: pointer ? this.reader(m.type.slice(0, -1)) : this.reader(m.type), pointer, hidden });
    }
    return (c) => {
      const out: Record<string, unknown> = {};
      let previous: unknown;
      for (const f of fields) {
        let value: unknown;
        if (f.pointer) {
          const length = Number(previous);
          const items = new Array<unknown>(length);
          for (let j = 0; j < length; j++) items[j] = f.read(c);
          value = items;
        } else value = f.read(c);
        if (!f.hidden) out[f.name] = value;
        previous = value;
      }
      return out;
    };
  }

  #compile(raw: string): Reader {
    const type = raw.startsWith("@") ? raw.slice(1) : raw;
    const primitive = PRIMITIVES[type];
    if (primitive !== undefined) return primitive;

    const item = generic(type, "core::array::Array") ?? generic(type, "core::array::Span");
    if (item !== undefined) return array(this.reader(item));
    const some = generic(type, "core::option::Option");
    if (some !== undefined) return option(this.reader(some));
    const res = generic(type, "core::result::Result");
    if (res !== undefined) {
      const [ok, err] = splitTopLevel(res);
      return result(this.reader(ok!), this.reader(err!));
    }
    const nonZero = generic(type, "core::zeroable::NonZero");
    if (nonZero !== undefined) return this.reader(nonZero);
    if (type.startsWith("core::internal::bounded_int::BoundedInt::<")) return signed(false);

    if (type.startsWith("(") && type.endsWith(")")) {
      const parts = splitTopLevel(type.slice(1, -1));
      const named = parts.length > 0 && parts.every((p) => p.includes(":") && !p.includes("::"));
      if (named) {
        return this.members(parts.map((p) => {
          const at = p.indexOf(":");
          return { name: p.slice(0, at).trim(), type: p.slice(at + 1).trim() };
        }));
      }
      return tuple(parts.map((p) => this.reader(p)));
    }

    if (type === "Uint256") return u256;
    const struct = this.#structs.get(type);
    if (struct !== undefined) return this.members(struct.members);

    const en = this.#enums.get(type);
    if (en !== undefined) {
      const variants = en.variants.map((v) => ({ name: v.name, read: this.reader(v.type), unit: v.type === "()" }));
      const allUnit = variants.every((v) => v.unit);
      return (c) => {
        const index = Number(next(c));
        const v = variants[index];
        if (v === undefined) throw new DecodeError(`${type}: no variant ${index}`);
        if (allUnit) return v.name;
        return { variant: v.name, value: v.read(c) };
      };
    }

    throw new DecodeError(`unsupported type ${raw}`);
  }
}
