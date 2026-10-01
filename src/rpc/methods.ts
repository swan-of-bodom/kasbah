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
