import type { RpcClient } from "./client.ts";

export type BlockId = { block_number: number } | { block_hash: string } | "latest" | "l1_accepted" | "pre_confirmed";

export type EmittedEvent = {
  from_address: string;
  keys: string[];
  data: string[];
  block_hash?: string;
  block_number?: number;
  transaction_hash: string;
  transaction_index: number;
  event_index: number;
};

export type EventsPage = { events: EmittedEvent[]; continuation_token?: string };

export type EventFilter = {
  from_block: BlockId;
  to_block: BlockId;
  address?: string | string[];
  keys?: string[][];
};

export type BlockHeader = {
  block_hash: string;
  parent_hash: string;
  block_number: number;
  timestamp: number;
  status: string;
};

export const getEvents = (rpc: RpcClient, filter: EventFilter, chunkSize: number, token?: string) =>
  rpc.request<EventsPage>("starknet_getEvents", {
    filter: { ...filter, chunk_size: chunkSize, ...(token === undefined ? {} : { continuation_token: token }) },
  });

export const blockNumber = (rpc: RpcClient) => rpc.request<number>("starknet_blockNumber", []);

export const specVersion = (rpc: RpcClient) => rpc.request<string>("starknet_specVersion", []);

/** Headers for many blocks, `batchSize` calls per HTTP request. The transaction hash list is dropped. */
export async function getHeaders(rpc: RpcClient, numbers: number[], batchSize: number): Promise<BlockHeader[]> {
  const requests: Promise<(BlockHeader & { transactions?: unknown })[]>[] = [];
  for (let i = 0; i < numbers.length; i += batchSize) {
    const calls = numbers.slice(i, i + batchSize).map((n) => ({
      method: "starknet_getBlockWithTxHashes",
      params: { block_id: { block_number: n } },
    }));
    requests.push(rpc.batch(calls));
  }
  return (await Promise.all(requests)).flat().map(({ block_hash, parent_hash, block_number, timestamp, status }) => ({
    block_hash,
    parent_hash,
    block_number,
    timestamp,
    status,
  }));
}

/** A transaction as `starknet_getTransactionByHash` returns it (spec 0.10). Felts stay hex strings. */
export type Transaction = {
  transaction_hash: string;
  type: "INVOKE" | "DECLARE" | "DEPLOY_ACCOUNT" | "DEPLOY" | "L1_HANDLER";
  version: string;
  sender_address?: string;
  contract_address?: string;
  calldata?: string[];
  signature?: string[];
  nonce?: string;
  tip?: string;
  resource_bounds?: Record<string, { max_amount: string; max_price_per_unit: string }>;
  paymaster_data?: string[];
  account_deployment_data?: string[];
  entry_point_selector?: string;
  class_hash?: string;
  [field: string]: unknown;
};

/** A receipt as `starknet_getTransactionReceipt` returns it. */
export type Receipt = {
  transaction_hash: string;
  type: Transaction["type"];
  actual_fee: { amount: string; unit: "WEI" | "FRI" };
  execution_status: "SUCCEEDED" | "REVERTED";
  finality_status: string;
  revert_reason?: string;
  events: { from_address: string; keys: string[]; data: string[] }[];
  messages_sent: { from_address: string; to_address: string; payload: string[] }[];
  execution_resources: Record<string, number>;
  block_hash?: string;
  block_number?: number;
  [field: string]: unknown;
};
