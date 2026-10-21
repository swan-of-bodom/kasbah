import { type Batch, eventStream, type FetchGauges } from "../sync/fetch.ts";
import { canonical } from "../types/felt.ts";
import type { Run } from "./open.ts";

/** A child as its factory's creation event says: `address` (canonical), created by `contract`'s factory in `block`. */
export type Child = { address: string; contract: string; block: number };

/**
 * Ordered batches of `addresses` × `keys` in `[from, to]`. Final ranges: the cached prefix first, then RPC, tracked
 * for the cache (the phase calls `cache.untrack` after its last commit). Live ranges: RPC only.
 */
export async function* events(
  run: Run,
  addresses: string[],
  keys: string[][],
  from: number,
  to: number,
  final: boolean,
): AsyncGenerator<Batch> {
  const { rpc, endpoint, config, status } = run;
  const cache = final ? run.cache : undefined;
  if (addresses.length === 0 || keys[0]!.length === 0) {
    for (let lo = from; lo <= to; lo += 100_000)
      yield { events: [], through: Math.min(to, lo + 99_999) };
    return;
  }
  let start = from;
  if (cache !== undefined) {
    const end = Math.min(to, (await cache.coveredUntil(addresses, keys[0]!, from)) - 1);
    if (end >= from) {
      yield* cache.read(addresses, keys[0]!, from, end);
      start = end + 1;
    }
    if (start <= to) cache.track(addresses, keys[0]!, start);
  }
  if (start > to) return;
  const gauges = (read: () => FetchGauges) => (status.fetcher = read);
  for await (const batch of eventStream({
    rpc,
    address: addresses,
    keys,
    from: start,
    to,
    chunkSize: endpoint.maxChunk,
    concurrency: config.concurrency ?? 32,
    gauges,
  })) {
    cache?.add(batch.events);
    yield batch;
  }
  status.fetcher = undefined;
}

/** The children the factories created in `[from, to]`, batch by batch. The one decoder of creation events. */
export async function* children(
  run: Run,
  from: number,
  to: number,
  final: boolean,
): AsyncGenerator<{ through: number; children: Child[] }> {
  const byAddress = new Map(run.factories.map((f) => [f.address, f]));
  const keys = [[...new Set(run.factories.flatMap((f) => f.reader.selectors))]];
  for await (const batch of events(
    run,
    run.factories.map((f) => f.address),
    keys,
    from,
    to,
    final,
  )) {
    const children: Child[] = [];
    for (const e of batch.events) {
      const f = byAddress.get(canonical(e.from_address));
      if (f === undefined || e.block_number! < f.startBlock) continue;
      const address = f.reader.child(e);
      if (address !== undefined)
        children.push({ address, contract: f.contract, block: e.block_number! });
    }
    yield { through: batch.through, children };
  }
}
