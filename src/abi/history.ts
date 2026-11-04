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
 * Pass `atFrom` when the class at `from` is already known, so it isn't asked again. Its `classHash` is undefined if
 * the contract wasn't deployed yet.
 */
export async function classHistory(
  rpc: RpcClient,
  address: string,
  from: number,
  to: number,
  step = 1_000_000,
  atFrom?: { classHash: string | undefined },
): Promise<ClassSpan[]> {
  const points: number[] = [];
  for (let b = from; b < to; b += step) points.push(b);
  points.push(to);
  const classes = await Promise.all(
    points.map((b, i) =>
      i === 0 && atFrom !== undefined ? atFrom.classHash : classAt(rpc, address, b),
    ),
  );

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

/** A contract's classes from block `from` to block `through`. `through` is final, so no reorg can change them. */
export type KnownClasses = { from: number; through: number; spans: ClassSpan[] };

/** Keeps class histories and ABIs from one run to the next. What is final about a contract never changes. */
export type ClassStore = {
  history(address: string): Promise<KnownClasses | undefined>;
  saveHistory(address: string, known: KnownClasses): Promise<void>;
  abi(classHash: string): Promise<Abi | undefined>;
  saveAbi(classHash: string, abi: Abi): Promise<void>;
};

function clip(spans: ClassSpan[], from: number, to: number): ClassSpan[] {
  const atFrom = spans.filter((s) => s.from <= from).at(-1);
  return [
    ...(atFrom === undefined ? [] : [{ from, classHash: atFrom.classHash }]),
    ...spans.filter((s) => s.from > from && s.from <= to),
  ];
}

/** The blocks `storedClassHistory` covers, `from` to `to` (the tip). `final` is the newest block no reorg can undo. */
export type ClassRange = { from: number; to: number; final: number; step?: number };

/**
 * `classHistory`, reusing what `store` knows up to a final block. A restart probes only from there to `to`: one call,
 * plus ~25 per class change since. The history up to `final` is saved for the next run.
 */
export async function storedClassHistory(
  rpc: RpcClient,
  store: ClassStore,
  address: string,
  { from, to, final, step }: ClassRange,
): Promise<ClassSpan[]> {
  const known = await store.history(address);
  let all: ClassSpan[];
  let start: number;
  let before = -1;
  if (known !== undefined && known.from <= from && from <= known.through) {
    if (to <= known.through) return clip(known.spans, from, to);
    const atThrough = known.spans.at(-1)?.classHash;
    const later = await classHistory(rpc, address, known.through, to, step, {
      classHash: atThrough,
    });
    all = [...known.spans, ...later.filter((s) => s.from > known.through)];
    start = known.from;
    before = known.through;
  } else {
    all = await classHistory(rpc, address, from, to, step);
    start = from;
  }
  const through = Math.min(to, final);
  if (through >= start && through > before)
    await store.saveHistory(address, {
      from: start,
      through,
      spans: all.filter((s) => s.from <= through),
    });
  return clip(all, from, to);
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
