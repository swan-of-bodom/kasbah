import type { EmittedEvent } from "../rpc/methods.ts";
import { type Batch, eventStream, type FetchGauges } from "../sync/fetch.ts";
import { canonical } from "../types/felt.ts";
import type { Run } from "./open.ts";

/** With nothing to fetch, blocks still pass in steps of this many, so block handlers and progress keep moving. */
const EMPTY_STEP = 100_000;

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
  cached = true,
): AsyncGenerator<Batch> {
  const { rpc, endpoint, config, status } = run;
  const cache = final && cached ? run.cache : undefined;
  if (addresses.length === 0 || keys[0]!.length === 0) {
    for (let lo = from; lo <= to; lo += EMPTY_STEP)
      yield { events: [], through: Math.min(to, lo + EMPTY_STEP - 1) };
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
    concurrency: config.concurrency,
    gauges,
  })) {
    cache?.add(batch.events);
    yield batch;
  }
  status.fetcher = undefined;
}

/**
 * The watched contracts' events: the shared stream merged with each filtered event's own (`sources.streams`). Those
 * skip the raw-event cache, which records what it holds by address and selector, not by key filter.
 */
export function watchedEvents(
  run: Run,
  from: number,
  to: number,
  final: boolean,
): AsyncGenerator<Batch> {
  const { sources } = run;
  const main = events(run, sources.addresses, sources.keys, from, to, final);
  if (sources.streams.length === 0) return main;
  return merge([
    main,
    ...sources.streams.map((s) => events(run, s.addresses, s.keys, from, to, final, false)),
  ]);
}

const order = (a: EmittedEvent, b: EmittedEvent) =>
  a.block_number! - b.block_number! ||
  a.transaction_index - b.transaction_index ||
  a.event_index - b.event_index;

/** Several streams over the same range as one, in chain order: through the lowest `through`, duplicates dropped. */
export async function* merge(streams: AsyncGenerator<Batch>[]): AsyncGenerator<Batch> {
  const state = streams.map(() => ({ through: -1, done: false, events: [] as EmittedEvent[] }));
  let yielded = -1;
  try {
    for (;;) {
      const open = state.filter((x) => !x.done);
      if (open.length === 0) break;
      // The stream furthest behind is the one holding the merged `through` back.
      const s = open.reduce((a, b) => (b.through < a.through ? b : a));
      const r = await streams[state.indexOf(s)]!.next();
      if (r.done) s.done = true;
      else {
        for (const e of r.value.events) s.events.push(e);
        s.through = r.value.through;
      }
      const still = state.filter((x) => !x.done);
      const upTo =
        still.length > 0
          ? Math.min(...still.map((x) => x.through))
          : Math.max(...state.map((x) => x.through));
      if (upTo <= yielded) continue;
      const out: EmittedEvent[] = [];
      for (const x of state) {
        let n = 0;
        while (n < x.events.length && x.events[n]!.block_number! <= upTo) n++;
        for (const e of x.events.splice(0, n)) out.push(e);
      }
      out.sort(order);
      yielded = upTo;
      yield { events: out.filter((e, i) => i === 0 || order(out[i - 1]!, e) !== 0), through: upTo };
    }
  } finally {
    await Promise.all(streams.map((x) => x.return(undefined)));
  }
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
