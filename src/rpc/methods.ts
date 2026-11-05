import { chunks } from "../utils/chunks.ts";
import type { RpcClient } from "./client.ts";

export type BlockId =
  | { block_number: number }
  | { block_hash: string }
  | "latest"
  | "l1_accepted"
  | "pre_confirmed";

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

type ResourcePrice = { price_in_fri: string; price_in_wei: string };

/** `BLOCK_HEADER` as the node returns it (spec 0.10), without the block's `status`, which changes as it settles. */
export type BlockHeader = {
  block_hash: string;
  parent_hash: string;
  block_number: number;
  new_root: string;
  timestamp: number;
  sequencer_address: string;
  l1_gas_price: ResourcePrice;
  l2_gas_price: ResourcePrice;
  l1_data_gas_price: ResourcePrice;
  l1_da_mode: "BLOB" | "CALLDATA";
  starknet_version: string;
  event_commitment: string;
  transaction_commitment: string;
  receipt_commitment: string;
  state_diff_commitment: string;
  event_count: number;
  transaction_count: number;
  state_diff_length: number;
};

/** One page of events. `attempts`: as `RpcClient.request`'s. */
export const getEvents = (
  rpc: RpcClient,
  filter: EventFilter,
  chunkSize: number,
  token?: string,
  o: { attempts?: number } = {},
) =>
  rpc.request<EventsPage>(
    "starknet_getEvents",
    {
      filter: {
        ...filter,
        chunk_size: chunkSize,
        ...(token === undefined ? {} : { continuation_token: token }),
      },
    },
    o,
  );

export const blockNumber = (rpc: RpcClient) => rpc.request<number>("starknet_blockNumber", []);

export const specVersion = (rpc: RpcClient) => rpc.request<string>("starknet_specVersion", []);

/** Headers for many blocks, `batchSize` calls per HTTP request. The transaction hash list and status are dropped. */
export async function getHeaders(
  rpc: RpcClient,
  numbers: number[],
  batchSize: number,
): Promise<BlockHeader[]> {
  const requests = [...chunks(numbers, batchSize)].map((part) =>
    rpc.batch<(BlockHeader & { transactions?: unknown; status?: string })[]>(
      part.map((n) => ({
        method: "starknet_getBlockWithTxHashes",
        params: { block_id: { block_number: n } },
      })),
    ),
  );
  return (await Promise.all(requests))
    .flat()
    .map(({ transactions: _, status: __, ...header }) => header);
}
