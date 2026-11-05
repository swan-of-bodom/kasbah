/**
 * Felts as the event cache stores them in `bytea`: each felt's minimal big-endian bytes, and lists of felts packed
 * one after another, each with a length byte.
 */

/** A felt's minimal hex digits, an even count, without `0x`. */
export function feltHex(felt: string): string {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(felt)) throw new Error(`not a felt: ${felt}`);
  let i = 2;
  while (i < felt.length && felt.charCodeAt(i) === 48) i++;
  const h = felt.slice(i).toLowerCase();
  return h.length % 2 === 1 ? `0${h}` : h;
}
export const feltBytes = (felt: string): Buffer => Buffer.from(feltHex(felt), "hex");
/** A felt from its minimal bytes as hex. */
export const feltFromMinimalBytes = (h: string): string =>
  h.length === 0 ? "0x0" : h.charCodeAt(0) === 48 ? `0x${h.slice(1)}` : `0x${h}`;

/** Felts as one bytea: per felt, a length byte then its minimal big-endian bytes. */
export function packFelts(felts: readonly string[]): Buffer {
  return Buffer.from(packFeltsHex(felts), "hex");
}

export function packFeltsHex(felts: readonly string[]): string {
  let out = "";
  for (const f of felts) {
    const h = feltHex(f);
    out += (h.length / 2).toString(16).padStart(2, "0") + h;
  }
  return out;
}

/** A lowercase hex digit's value. */
const nibble = (c: number) => (c < 97 ? c - 48 : c - 87);

/**
 * A packed list from the bytea's hex text, as Postgres' `encode(x, 'hex')` returns it (lowercase). Each length
 * byte is read from its two characters' codes: slicing it out for `parseInt` cost ~40% more per felt.
 */
export function unpackHex(h: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < h.length; ) {
    const n = (nibble(h.charCodeAt(i)) * 16 + nibble(h.charCodeAt(i + 1))) * 2;
    out.push(feltFromMinimalBytes(h.slice(i + 2, i + 2 + n)));
    i += 2 + n;
  }
  return out;
}

/** A packed felt's length byte as two hex digits, by byte count (a felt has at most 32). */
const LENGTH_BYTE = Array.from({ length: 33 }, (_, n) => n.toString(16).padStart(2, "0"));

/**
 * `feltHex` for COPY lines, with only the prefix and length checked: Postgres rejects any other digit when it decodes
 * the bytea. Checking every digit here took ~70% of building an event's line.
 */
export function copyHex(felt: string): string {
  if (
    felt.length < 3 ||
    felt.length > 66 ||
    felt.charCodeAt(0) !== 48 ||
    felt.charCodeAt(1) !== 120
  )
    throw new Error(`not a felt: ${felt}`);
  let i = 2;
  while (i < felt.length && felt.charCodeAt(i) === 48) i++;
  return (felt.length - i) % 2 === 1 ? `0${felt.slice(i)}` : felt.slice(i);
}

/** `packFeltsHex` for COPY lines (see `copyHex`). */
export function packCopyHex(felts: readonly string[]): string {
  let out = "";
  for (const f of felts) {
    const h = copyHex(f);
    out += LENGTH_BYTE[h.length >> 1] + h;
  }
  return out;
}
