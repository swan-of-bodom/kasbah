import type { BlockHeader } from "./rpc/methods.ts";

type Hex = `0x${string}`;

/** Gas price in fri (STRK) and wei (ETH) per unit. */
export type GasPrice = { fri: bigint; wei: bigint };

/**
 * A block header (spec `BLOCK_HEADER`), with `include: { block: true }` and in block handlers. Blocks older than a
 * field have it as the node returns it: `0x0` commitments, `0` counts and prices (`1` for l1 data gas), `""` version.
 * Hashes and addresses are the node's hex, unpadded.
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
    hash: h.block_hash as Hex,
    parentHash: h.parent_hash as Hex,
    timestamp: h.timestamp,
    newRoot: h.new_root as Hex,
    sequencerAddress: h.sequencer_address as Hex,
    starknetVersion: h.starknet_version,
    l1GasPrice: price(h.l1_gas_price),
    l2GasPrice: price(h.l2_gas_price),
    l1DataGasPrice: price(h.l1_data_gas_price),
    l1DaMode: h.l1_da_mode,
    eventCount: h.event_count,
    transactionCount: h.transaction_count,
    stateDiffLength: h.state_diff_length,
    eventCommitment: h.event_commitment as Hex,
    transactionCommitment: h.transaction_commitment as Hex,
    receiptCommitment: h.receipt_commitment as Hex,
    stateDiffCommitment: h.state_diff_commitment as Hex,
  };
}
