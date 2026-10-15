import { felt, type Felt as Hex } from "./felt.ts";
import type { BlockHeader } from "../rpc/methods.ts";

/** Gas price in fri (STRK) and wei (ETH) per unit. */
export type GasPrice = { fri: bigint; wei: bigint };

/**
 * A block header (spec `BLOCK_HEADER`), with `include: { block: true }` and in block handlers. Blocks older than a
 * field have it as the node returns it: zero commitments, `0` counts and prices (`1` for l1 data gas), `""` version.
 * Hashes and addresses are padded felts (`felt`).
 */
export type Block = {
  number: number;
  hash: Hex;
  parentHash: Hex;
  /** Unix seconds, set when the sequencer started the block. */
  timestamp: number;
  newRoot: Hex;
  sequencerAddress: Hex;
  /** Semver of the Starknet protocol, e.g. `0.14.0`. */
  starknetVersion: string;
  l1GasPrice: GasPrice;
  l2GasPrice: GasPrice;
  l1DataGasPrice: GasPrice;
  /** How the block's data is published to L1. */
  l1DaMode: "BLOB" | "CALLDATA";
  eventCount: number;
  transactionCount: number;
  stateDiffLength: number;
  eventCommitment: Hex;
  transactionCommitment: Hex;
  receiptCommitment: Hex;
  stateDiffCommitment: Hex;
};

const price = (p: { price_in_fri: string; price_in_wei: string }): GasPrice => ({ fri: BigInt(p.price_in_fri), wei: BigInt(p.price_in_wei) });

export function blockOf(h: BlockHeader): Block {
  return {
    number: h.block_number,
    hash: felt(h.block_hash),
    parentHash: felt(h.parent_hash),
    timestamp: h.timestamp,
    newRoot: felt(h.new_root),
    sequencerAddress: felt(h.sequencer_address),
    starknetVersion: h.starknet_version,
    l1GasPrice: price(h.l1_gas_price),
    l2GasPrice: price(h.l2_gas_price),
    l1DataGasPrice: price(h.l1_data_gas_price),
    l1DaMode: h.l1_da_mode,
    eventCount: h.event_count,
    transactionCount: h.transaction_count,
    stateDiffLength: h.state_diff_length,
    eventCommitment: felt(h.event_commitment),
    transactionCommitment: felt(h.transaction_commitment),
    receiptCommitment: felt(h.receipt_commitment),
    stateDiffCommitment: felt(h.state_diff_commitment),
  };
}
