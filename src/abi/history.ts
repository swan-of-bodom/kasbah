import type { RpcClient } from "../rpc/client.ts";
import { RpcError } from "../rpc/client.ts";
import type { Abi } from "./abi.ts";
import { createDecoder } from "./events.ts";
import type { DecodedEvent } from "./types.ts";

/** The class a contract had from `from` (inclusive) until the next entry. */
export type ClassSpan = { from: number; classHash: string };

const CONTRACT_NOT_FOUND = 20;

async function classAt(
  rpc: RpcClient,
  address: string,
  block: number,
): Promise<string | undefined> {
  try {
    return await rpc.request<string>("starknet_getClassHashAt", {
      block_id: { block_number: block },
      contract_address: address,
    });
  } catch (e) {
    if (e instanceof RpcError && e.code === CONTRACT_NOT_FOUND) return undefined;
    throw e;
  }
}

/** The block `address` was deployed in, or undefined if not by `to`: a binary search, about 25 calls. */
export async function deployedAt(
  rpc: RpcClient,
  address: string,
  to: number,
): Promise<number | undefined> {
  if ((await classAt(rpc, address, to)) === undefined) return undefined;
  if ((await classAt(rpc, address, 0)) !== undefined) return 0;
  let [lo, hi] = [0, to];
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if ((await classAt(rpc, address, mid)) === undefined) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * Every class a contract had over `[from, to]`, found by bisecting `getClassHashAt`: about 25 calls per change.
 * A class replaced and then restored between two probes is invisible; probes every `step` blocks bound that window.
 */
export async function classHistory(
  rpc: RpcClient,
  address: string,
  from: number,
  to: number,
  step = 1_000_000,
): Promise<ClassSpan[]> {
  const points: number[] = [];
  for (let b = from; b < to; b += step) points.push(b);
  points.push(to);
  const classes = await Promise.all(points.map((b) => classAt(rpc, address, b)));

  const changes: ClassSpan[] = [];
  const bisect = async (
    lo: number,
    loClass: string | undefined,
    hi: number,
    hiClass: string | undefined,
  ): Promise<void> => {
    if (loClass === hiClass) return;
    if (hi - lo === 1) {
      if (hiClass !== undefined) changes.push({ from: hi, classHash: hiClass });
      return;
    }
    const mid = lo + Math.floor((hi - lo) / 2);
    const midClass = await classAt(rpc, address, mid);
    await Promise.all([bisect(lo, loClass, mid, midClass), bisect(mid, midClass, hi, hiClass)]);
  };
  await Promise.all(
    points.slice(1).map((b, i) => bisect(points[i]!, classes[i], b, classes[i + 1])),
  );

  const start = classes[0] === undefined ? [] : [{ from, classHash: classes[0] }];
  return [...start, ...changes.sort((a, b) => a.from - b.from)];
}

export type Decode = (
  keys: readonly string[],
  data: readonly string[],
) => DecodedEvent<Abi> | undefined;

/**
 * Decodes each event with the ABI of the class the contract had at that event's block. `decoderFor` lets contracts
 * that share classes (factory children) share decoders.
 */
export function createHistoricalDecoder(
  spans: (ClassSpan & { abi: Abi })[],
  decoderFor: (abi: Abi) => Decode = createDecoder,
) {
  const decoders = spans.map((s) => ({ from: s.from, decode: decoderFor(s.abi) }));
  return (
    block: number,
    keys: readonly string[],
    data: readonly string[],
  ): DecodedEvent<Abi> | undefined => {
    let lo = 0;
    let hi = decoders.length - 1;
    if (hi < 0 || block < decoders[0]!.from) return undefined;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (decoders[mid]!.from <= block) lo = mid;
      else hi = mid - 1;
    }
    return decoders[lo]!.decode(keys, data);
  };
}
