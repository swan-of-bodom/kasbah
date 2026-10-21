export type Felt = `0x${string}`;

/**
 * The one form of every felt the indexer hands out (events, blocks, transactions, receipts, calls, `selector`):
 * `0x` and 64 lowercase hex digits, so equal felts are equal strings. Inside, felts stay as the node sends them.
 */
export function felt(hex: string): Felt {
  if (hex.length === 66 && hex === hex.toLowerCase()) return hex as Felt;
  return `0x${hex.slice(2).toLowerCase().padStart(64, "0")}` as Felt;
}

/** The node's form of a felt: no leading zeros, as the spec's `FELT` pattern requires in requests. */
export const unpadded = (hex: string): Felt => `0x${hex.slice(2).replace(/^0+(?=.)/, "")}` as Felt;

/** An address or felt as a key: lowercase, no leading zeros, whatever form it came in (config, node, ABI). */
export const canonical = (hex: string): string => `0x${BigInt(hex).toString(16)}`;
