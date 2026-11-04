import type { EmittedEvent } from "../rpc/methods.ts";
import type { Batch } from "../sync/fetch.ts";
import { fetchThread } from "../sync/fetch-thread.ts";
import { pages } from "../sync/live.ts";
import { canonical } from "../types/felt.ts";
import type { Run } from "./open.ts";

/** With nothing to fetch, blocks still pass in steps of this many, so block handlers and progress keep moving. */
const EMPTY_STEP = 100_000;

/** A child as its factory's creation event says: `address` (canonical), created by `contract`'s factory in `block`. */
export type Child = { address: string; contract: string; block: number };

/**
 * Ordered batches of `addresses` × `keys` in `[from, to]`, final blocks: what the cache lacks is fetched into it by a
 * thread of its own, and every batch is read back from it as far as it holds every block. Keys past the selector
 * filter: the cache records their coverage apart and filters what it reads back.
 */
export async function* events(
  run: Run,
  addresses: string[],
  keys: string[][],
  from: number,
  to: number,
): AsyncGenerator<Batch> {
  const { rpc, endpoint, config, status, cache } = run;
  if (addresses.length === 0 || keys[0]!.length === 0) {
    for (let lo = from; lo <= to; lo += EMPTY_STEP)
      yield { events: [], through: Math.min(to, lo + EMPTY_STEP - 1) };
    return;
  }
  const selectors = keys[0]!;
  const filter = keys.slice(1);
  const missing = await cache.missing(addresses, selectors, from, to, filter);
  const written =
    missing.length === 0
      ? undefined
      : fetchThread(
          { rpc, status, cache, database: config.database, signal: run.signal },
          {
            addresses,
            keys,
            from,
            to,
            ranges: missing,
            chunkSize: endpoint.maxChunk,
            concurrency: config.concurrency,
          },
        );
  let next = from;
  try {
    for await (const { through } of written ?? whole(to)) {
      for (const [lo, hi, fetched] of pieces(next, through, missing))
        yield* cache.read(addresses, selectors, lo, hi, undefined, !fetched, filter);
      next = through + 1;
    }
  } finally {
    await written?.return(undefined);
  }
}

async function* whole(to: number): AsyncGenerator<Batch> {
  yield { events: [], through: to };
}

/** `[lo, hi]` cut at the edges of `ranges`, each piece saying whether it lies in one of them. */
function* pieces(
  lo: number,
  hi: number,
  ranges: [number, number][],
): Generator<[number, number, boolean]> {
  let at = lo;
  for (const [a, b] of ranges) {
    if (b < at) continue;
    if (a > hi) break;
    if (a > at) yield [at, a - 1, false];
    const end = Math.min(b, hi);
    yield [Math.max(a, at), end, true];
    at = end + 1;
    if (at > hi) return;
  }
  if (at <= hi) yield [at, hi, false];
}

/**
 * The watched contracts' events in final blocks: the shared stream merged with each contract's own
 * (`sources.streams`), each from its contract's start block.
 */
export function watchedEvents(run: Run, from: number, to: number): AsyncGenerator<Batch> {
  const { sources } = run;
  if (sources.streams.length === 0) return shared(run, from, to);
  return merge([
    shared(run, from, to),
    ...sources.streams.flatMap((s) => {
      const start = Math.max(from, s.from);
      const end = Math.min(to, s.to ?? to);
      return end < start ? [] : [events(run, s.addresses, s.keys, start, end)];
    }),
  ]);
}

/**
 * The shared stream, cut at each configured contract's start block: each piece asks only for the addresses started
 * by then, so a contract starting late isn't fetched (and dropped) from the earliest start.
 * Factory children join at once: nothing is emitted before their creation.
 */
async function* shared(run: Run, from: number, to: number): AsyncGenerator<Batch> {
  const { sources } = run;
  const startOf = (a: string) => {
    const w = sources.byAddress.get(a)!;
    return w.child ? Number.NEGATIVE_INFINITY : w.from;
  };
  const cuts = [...new Set(sources.addresses.map(startOf))]
    .filter((s) => s > from && s <= to)
    .sort((a, b) => a - b);
  if (cuts.length === 0) {
    yield* events(run, sources.addresses, sources.keys, from, to);
    return;
  }
  const edges = [from, ...cuts, to + 1];
  for (let i = 0; i < edges.length - 1; i++) {
    const [lo, hi] = [edges[i]!, edges[i + 1]! - 1];
    const started = sources.addresses.filter((a) => startOf(a) <= lo);
    yield* events(run, started, sources.keys, lo, hi);
  }
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
  final = true,
): AsyncGenerator<{ through: number; children: Child[] }> {
  const byAddress = new Map(run.factories.map((f) => [f.address, f]));
  const keys = [[...new Set(run.factories.flatMap((f) => f.reader.selectors))]];
  const addresses = run.factories.map((f) => f.address);
  // Blocks that may still reorg stay out of the cache: a live tick's few are fetched directly.
  const batches = final
    ? events(run, addresses, keys, from, to)
    : unfinal(run, addresses, keys, from, to);
  for await (const batch of batches) {
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

async function* unfinal(
  run: Run,
  addresses: string[],
  keys: string[][],
  from: number,
  to: number,
): AsyncGenerator<Batch> {
  const o = { rpc: run.rpc, chunkSize: run.endpoint.maxChunk };
  yield { events: await pages(o, addresses, keys, from, to), through: to };
}
