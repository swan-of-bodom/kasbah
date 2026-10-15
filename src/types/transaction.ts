import { felt, type Felt as Hex } from "./felt.ts";

/** Spec `RESOURCE_BOUNDS`: the most gas and price per unit a v3 transaction pays. */
export type ResourceBounds = { maxAmount: bigint; maxPricePerUnit: bigint };
export type DaMode = "L1" | "L2";

/** The fields every v3 transaction (spec `*_TXN_V3`) adds over earlier versions, which pay with `maxFee` instead. */
type V3 = {
  resourceBounds: { l1Gas: ResourceBounds; l1DataGas: ResourceBounds; l2Gas: ResourceBounds };
  tip: bigint;
  paymasterData: Hex[];
  nonceDataAvailabilityMode: DaMode;
  feeDataAvailabilityMode: DaMode;
};

type Common = { hash: Hex; signature: Hex[] };

/**
 * A transaction (spec `TXN_WITH_HASH`): one shape per type and version, narrowed by `type` and `version`. Felts are
 * padded (`felt`); amounts, fees and nonces are bigints. Versions with the query bit
 * (`0x1000…0003`) only exist in simulations, never on chain, so they're not here.
 */
export type Transaction =
  | (Common & { type: "INVOKE"; version: "0x0"; maxFee: bigint; contractAddress: Hex; entryPointSelector: Hex; calldata: Hex[] })
  | (Common & { type: "INVOKE"; version: "0x1"; maxFee: bigint; senderAddress: Hex; calldata: Hex[]; nonce: bigint })
  | (Common & V3 & { type: "INVOKE"; version: "0x3"; senderAddress: Hex; calldata: Hex[]; nonce: bigint; accountDeploymentData: Hex[] })
  | { hash: Hex; type: "L1_HANDLER"; version: "0x0"; nonce: bigint; contractAddress: Hex; entryPointSelector: Hex; calldata: Hex[] }
  | (Common & { type: "DEPLOY_ACCOUNT"; version: "0x1"; maxFee: bigint; nonce: bigint; contractAddressSalt: Hex; constructorCalldata: Hex[]; classHash: Hex })
  | (Common & V3 & { type: "DEPLOY_ACCOUNT"; version: "0x3"; nonce: bigint; contractAddressSalt: Hex; constructorCalldata: Hex[]; classHash: Hex })
  | { hash: Hex; type: "DEPLOY"; version: Hex; contractAddressSalt: Hex; constructorCalldata: Hex[]; classHash: Hex }
  | (Common & { type: "DECLARE"; version: "0x0"; maxFee: bigint; senderAddress: Hex; classHash: Hex })
  | (Common & { type: "DECLARE"; version: "0x1"; maxFee: bigint; senderAddress: Hex; nonce: bigint; classHash: Hex })
  | (Common & { type: "DECLARE"; version: "0x2"; maxFee: bigint; senderAddress: Hex; nonce: bigint; classHash: Hex; compiledClassHash: Hex })
  | (Common & V3 & { type: "DECLARE"; version: "0x3"; senderAddress: Hex; nonce: bigint; classHash: Hex; compiledClassHash: Hex; accountDeploymentData: Hex[] });

/**
 * A receipt (spec `TXN_RECEIPT_WITH_BLOCK_INFO`), narrowed by `type` and `executionStatus`. Without `finality_status`:
 * it changes as the block settles, and a cached receipt would keep the old one.
 */
export type Receipt = {
  transactionHash: Hex;
  actualFee: { amount: bigint; unit: "WEI" | "FRI" };
  messagesSent: { fromAddress: Hex; toAddress: Hex; payload: Hex[] }[];
  events: { fromAddress: Hex; keys: Hex[]; data: Hex[] }[];
  executionResources: { l1Gas: number; l1DataGas: number; l2Gas: number };
  blockNumber: number;
  /** Absent while the block is pre-confirmed. */
  blockHash?: Hex;
} & ({ executionStatus: "SUCCEEDED" } | { executionStatus: "REVERTED"; revertReason: string }) &
  ({ type: "INVOKE" | "DECLARE" } | { type: "L1_HANDLER"; messageHash: Hex } | { type: "DEPLOY" | "DEPLOY_ACCOUNT"; contractAddress: Hex });

/** A transaction as `starknet_getTransactionByHash` returns it: what the cache keeps. */
export type RawTransaction = Record<string, unknown> & { transaction_hash: string; type: string; version: string };
/** A receipt as `starknet_getTransactionReceipt` returns it. */
export type RawReceipt = Record<string, unknown> & { transaction_hash: string; type: string; execution_status: string };

type RawBounds = { max_amount: string; max_price_per_unit: string };
const bounds = (b: RawBounds): ResourceBounds => ({ maxAmount: BigInt(b.max_amount), maxPricePerUnit: BigInt(b.max_price_per_unit) });

/** Spec name to ours: `contract_address_salt` → `contractAddressSalt`. */
const camel = (k: string) => k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** Fields that are numbers in the spec (`FELT`/`u64`/`u128`/`NUM_AS_HEX` amounts), as bigints. */
const AMOUNTS = new Set(["max_fee", "nonce", "tip"]);
/** String fields that aren't felts. */
const NAMES = new Set(["type", "version", "nonce_data_availability_mode", "fee_data_availability_mode"]);
const felts = (a: string[]) => a.map(felt);

export function transactionOf(raw: RawTransaction): Transaction {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "transaction_hash") out.hash = felt(v as string);
    else if (k === "resource_bounds") {
      const r = v as Record<"l1_gas" | "l1_data_gas" | "l2_gas", RawBounds>;
      out.resourceBounds = { l1Gas: bounds(r.l1_gas), l1DataGas: bounds(r.l1_data_gas), l2Gas: bounds(r.l2_gas) };
    } else if (AMOUNTS.has(k)) out[camel(k)] = BigInt(v as string);
    else if (NAMES.has(k)) out[camel(k)] = v;
    else out[camel(k)] = Array.isArray(v) ? felts(v as string[]) : felt(v as string);
  }
  return out as Transaction;
}

export function receiptOf(raw: RawReceipt): Receipt {
  const r = raw as RawReceipt & {
    actual_fee: { amount: string; unit: "WEI" | "FRI" };
    messages_sent: { from_address: Hex; to_address: Hex; payload: Hex[] }[];
    events: { from_address: Hex; keys: Hex[]; data: Hex[] }[];
    execution_resources: { l1_gas: number; l1_data_gas: number; l2_gas: number };
    block_number: number;
    block_hash?: Hex;
    revert_reason?: string;
    message_hash?: Hex;
    contract_address?: Hex;
  };
  return {
    transactionHash: felt(r.transaction_hash),
    type: r.type,
    actualFee: { amount: BigInt(r.actual_fee.amount), unit: r.actual_fee.unit },
    executionStatus: r.execution_status,
    ...(r.revert_reason === undefined ? {} : { revertReason: r.revert_reason }),
    messagesSent: r.messages_sent.map((m) => ({ fromAddress: felt(m.from_address), toAddress: felt(m.to_address), payload: felts(m.payload) })),
    events: r.events.map((e) => ({ fromAddress: felt(e.from_address), keys: felts(e.keys), data: felts(e.data) })),
    executionResources: { l1Gas: r.execution_resources.l1_gas, l1DataGas: r.execution_resources.l1_data_gas, l2Gas: r.execution_resources.l2_gas },
    blockNumber: r.block_number,
    ...(r.block_hash === undefined ? {} : { blockHash: felt(r.block_hash) }),
    ...(r.message_hash === undefined ? {} : { messageHash: felt(r.message_hash) }),
    ...(r.contract_address === undefined ? {} : { contractAddress: felt(r.contract_address) }),
  } as Receipt;
}
