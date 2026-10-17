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

const signed =
  (asNumber: boolean): Reader =>
  (c) => {
    const v = BigInt(next(c));
    const s = v > HALF_P ? v - P : v;
    return asNumber ? Number(s) : s;
  };

const pad =
  (width: number): Reader =>
  (c) =>
    `0x${next(c).slice(2).toLowerCase().padStart(width, "0")}`;

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

const array =
  (item: Reader): Reader =>
  (c) => {
    const length = Number(next(c));
    const out = new Array<unknown>(length);
    for (let i = 0; i < length; i++) out[i] = item(c);
    return out;
  };

const option =
  (inner: Reader): Reader =>
  (c) =>
    next(c) === "0x0" ? inner(c) : null;

const result =
  (ok: Reader, err: Reader): Reader =>
  (c) =>
    next(c) === "0x0" ? { ok: ok(c) } : { err: err(c) };

const tuple =
  (items: Reader[]): Reader =>
  (c) =>
    items.map((r) => r(c));

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

/** Encodes one value as felts (calldata). The inverse of `Reader`. */
export type Writer = (value: unknown, out: string[]) => void;

const toFelt = (v: unknown): bigint => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === "string" && v !== "") return BigInt(v);
  if (typeof v === "boolean") return v ? 1n : 0n;
  throw new TypeError(`not a number: ${String(v)}`);
};
const hexOf = (v: bigint) => `0x${v.toString(16)}`;
const W128 = (1n << U128) - 1n;

const wFelt: Writer = (v, out) => {
  const x = toFelt(v);
  if (x < 0n || x >= P) throw new TypeError(`${x} is not a felt`);
  out.push(hexOf(x));
};
const wUint =
  (bits: number): Writer =>
  (v, out) => {
    const x = toFelt(v);
    if (x < 0n || x >= 1n << BigInt(bits)) throw new TypeError(`${x} does not fit u${bits}`);
    out.push(hexOf(x));
  };
const wInt =
  (bits: number): Writer =>
  (v, out) => {
    const x = toFelt(v);
    const half = 1n << BigInt(bits - 1);
    if (x < -half || x >= half) throw new TypeError(`${x} does not fit i${bits}`);
    out.push(hexOf(x < 0n ? P + x : x));
  };
const wBool: Writer = (v, out) => {
  if (typeof v !== "boolean") throw new TypeError(`not a boolean: ${String(v)}`);
  out.push(v ? "0x1" : "0x0");
};
const wLimbs =
  (limbs: number): Writer =>
  (v, out) => {
    let x = toFelt(v);
    if (x < 0n || x >= 1n << (U128 * BigInt(limbs)))
      throw new TypeError(`${x} does not fit ${limbs * 128} bits`);
    for (let i = 0; i < limbs; i++, x >>= U128) out.push(hexOf(x & W128));
  };
const wByteArray: Writer = (v, out) => {
  if (typeof v !== "string") throw new TypeError(`not a string: ${String(v)}`);
  const bytes = new TextEncoder().encode(v);
  const full = Math.floor(bytes.length / 31);
  const word = (from: number, to: number) => {
    let x = 0n;
    for (let i = from; i < to; i++) x = (x << 8n) | BigInt(bytes[i]!);
    return hexOf(x);
  };
  out.push(hexOf(BigInt(full)));
  for (let w = 0; w < full; w++) out.push(word(w * 31, w * 31 + 31));
  out.push(word(full * 31, bytes.length), hexOf(BigInt(bytes.length - full * 31)));
};
const wUnit: Writer = () => {};

const WRITE_PRIMITIVES: Record<string, Writer> = {
  "core::felt252": wFelt,
  felt: wFelt,
  "core::bool": wBool,
  "core::integer::u8": wUint(8),
  "core::integer::u16": wUint(16),
  "core::integer::u32": wUint(32),
  "core::integer::usize": wUint(32),
  "core::integer::u64": wUint(64),
  "core::integer::u128": wUint(128),
  "core::integer::u256": wLimbs(2),
  "core::integer::u512": wLimbs(4),
  "core::integer::i8": wInt(8),
  "core::integer::i16": wInt(16),
  "core::integer::i32": wInt(32),
  "core::integer::i64": wInt(64),
  "core::integer::i128": wInt(128),
  "core::starknet::contract_address::ContractAddress": wFelt,
  "core::starknet::class_hash::ClassHash": wFelt,
  "core::starknet::storage_access::StorageAddress": wFelt,
  "core::starknet::eth_address::EthAddress": wUint(160),
  "core::bytes_31::bytes31": wUint(248),
  "core::byte_array::ByteArray": wByteArray,
  "()": wUnit,
};

const record = (v: unknown, type: string): Record<string, unknown> => {
  if (typeof v !== "object" || v === null) throw new TypeError(`${type}: expected an object`);
  return v as Record<string, unknown>;
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
  return type.startsWith(`${prefix}::<`) && type.endsWith(">")
    ? type.slice(prefix.length + 3, -1)
    : undefined;
}

/** Compiles ABI type strings into readers, memoized per ABI. Cairo 0 and Cairo 1 type syntax share one namespace. */
export class Codec {
  readonly #structs = new Map<string, AbiStruct>();
  readonly #enums = new Map<string, AbiEnum>();
  readonly #readers = new Map<string, Reader>();
  readonly #writers = new Map<string, Writer>();

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
      const hidden = nextMember?.type.endsWith("*") === true && m.name === `${nextMember.name}_len`;
      fields.push({
        name: m.name,
        read: pointer ? this.reader(m.type.slice(0, -1)) : this.reader(m.type),
        pointer,
        hidden,
      });
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

  writer(type: string): Writer {
    let w = this.#writers.get(type);
    if (w === undefined) {
      // Set before compiling so recursive types resolve to the finished writer.
      let compiled: Writer | undefined;
      this.#writers.set(type, (v, out) => compiled!(v, out));
      compiled = this.#compileWriter(type);
      w = compiled;
      this.#writers.set(type, w);
    }
    return w;
  }

  /** Writer for a member list, from an object. Cairo 0 `x_len` is written from the length of `x`. */
  membersWriter(members: readonly AbiMember[]): Writer {
    const fields = members.map((m, i) => {
      const nextMember = members[i + 1];
      const lengthOf =
        nextMember?.type.endsWith("*") && m.name === `${nextMember.name}_len`
          ? nextMember.name
          : undefined;
      const pointer = m.type.endsWith("*");
      return {
        name: m.name,
        lengthOf,
        pointer,
        write: this.writer(pointer ? m.type.slice(0, -1) : m.type),
      };
    });
    return (v, out) => {
      const o = record(v, "arguments");
      for (const f of fields) {
        if (f.lengthOf !== undefined) {
          const items = o[f.lengthOf];
          if (!Array.isArray(items)) throw new TypeError(`${f.lengthOf}: expected an array`);
          out.push(hexOf(BigInt(items.length)));
        } else if (f.pointer) {
          for (const item of o[f.name] as unknown[]) f.write(item, out);
        } else {
          if (!(f.name in o)) throw new TypeError(`missing ${f.name}`);
          f.write(o[f.name], out);
        }
      }
    };
  }

  #compileWriter(raw: string): Writer {
    const type = raw.startsWith("@") ? raw.slice(1) : raw;
    const primitive = WRITE_PRIMITIVES[type];
    if (primitive !== undefined) return primitive;

    const item = generic(type, "core::array::Array") ?? generic(type, "core::array::Span");
    if (item !== undefined) {
      const w = this.writer(item);
      return (v, out) => {
        if (!Array.isArray(v)) throw new TypeError(`${type}: expected an array`);
        out.push(hexOf(BigInt(v.length)));
        for (const x of v) w(x, out);
      };
    }
    const some = generic(type, "core::option::Option");
    if (some !== undefined) {
      const w = this.writer(some);
      return (v, out) => {
        if (v === null || v === undefined) out.push("0x1");
        else {
          out.push("0x0");
          w(v, out);
        }
      };
    }
    const res = generic(type, "core::result::Result");
    if (res !== undefined) {
      const [ok, err] = splitTopLevel(res).map((t) => this.writer(t));
      return (v, out) => {
        const r = record(v, type);
        if ("ok" in r) {
          out.push("0x0");
          ok!(r.ok, out);
        } else {
          out.push("0x1");
          err!(r.err, out);
        }
      };
    }
    const nonZero = generic(type, "core::zeroable::NonZero");
    if (nonZero !== undefined) return this.writer(nonZero);
    if (type.startsWith("core::internal::bounded_int::BoundedInt::<")) return wFelt;

    if (type.startsWith("(") && type.endsWith(")")) {
      const parts = splitTopLevel(type.slice(1, -1));
      const named = parts.length > 0 && parts.every((p) => p.includes(":") && !p.includes("::"));
      if (named) {
        return this.membersWriter(
          parts.map((p) => {
            const at = p.indexOf(":");
            return { name: p.slice(0, at).trim(), type: p.slice(at + 1).trim() };
          }),
        );
      }
      const items = parts.map((p) => this.writer(p));
      return (v, out) => {
        if (!Array.isArray(v) || v.length !== items.length)
          throw new TypeError(`${type}: expected ${items.length} items`);
        for (const [i, w] of items.entries()) w(v[i], out);
      };
    }

    if (type === "Uint256") return wLimbs(2);
    const struct = this.#structs.get(type);
    if (struct !== undefined) return this.membersWriter(struct.members);

    const en = this.#enums.get(type);
    if (en !== undefined) {
      const variants = new Map(
        en.variants.map((v, i) => [v.name, { index: i, write: this.writer(v.type) }]),
      );
      return (v, out) => {
        const [name, value] =
          typeof v === "string"
            ? [v, undefined]
            : [record(v, type).variant as string, record(v, type).value];
        const variant = variants.get(name);
        if (variant === undefined) throw new TypeError(`${type}: no variant ${name}`);
        out.push(hexOf(BigInt(variant.index)));
        variant.write(value, out);
      };
    }

    throw new TypeError(`unsupported type ${raw}`);
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
        return this.members(
          parts.map((p) => {
            const at = p.indexOf(":");
            return { name: p.slice(0, at).trim(), type: p.slice(at + 1).trim() };
          }),
        );
      }
      return tuple(parts.map((p) => this.reader(p)));
    }

    if (type === "Uint256") return u256;
    const struct = this.#structs.get(type);
    if (struct !== undefined) return this.members(struct.members);

    const en = this.#enums.get(type);
    if (en !== undefined) {
      const variants = en.variants.map((v) => ({
        name: v.name,
        read: this.reader(v.type),
        unit: v.type === "()",
      }));
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
