import { type Felt, felt } from "../types/felt.ts";
import { keccak_256 } from "@noble/hashes/sha3.js";

const MASK_250 = (1n << 250n) - 1n;
const encoder = new TextEncoder();

/** `sn_keccak(name)`: keccak256 truncated to 250 bits, as a minimal lowercase hex felt. */
/** As the node writes it (no leading zeros): what event keys and `starknet_call` are matched against. */
export function rawSelector(name: string): string {
  const hash = keccak_256(encoder.encode(name));
  let value = 0n;
  for (const byte of hash) value = (value << 8n) | BigInt(byte);
  return `0x${(value & MASK_250).toString(16)}`;
}

/** The selector of an event or function name, padded like every felt the indexer hands out. */
export const selector = (name: string): Felt => felt(rawSelector(name));
