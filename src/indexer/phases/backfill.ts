import type { Batch } from "../../sync/fetch.ts";
import { heapLimit } from "../../utils/memory.ts";
import { secondsSince } from "../../utils/time.ts";
import { watchedEvents } from "../events.ts";
import { blockHeaders, fire, handle, type Prefetched, prefetch } from "../handle.ts";
import type { BlockSource, Run } from "../open.ts";

/** Events (and block handlers) handled between two backfill commits. */
const FLUSH_EVENTS = 100_000;
/** Transactions and receipts the cache holds unwritten before it forces a commit, so memory stays bounded. */
const FLUSH_BYTES = 64 << 20;
/** Share of the heap for rows written but not yet committed: the row cache evicts only at a commit. */
const PENDING_SHARE = 1 / 10;

/**
 * Final blocks from the checkpoint to the backfill's end: a commit every `FLUSH_EVENTS` events, `FLUSH_BYTES` of
 * extras, or a tenth of the heap in written rows.
 */
export async function backfill(run: Run): Promise<void> {
  const { status, cache, signal, position } = run;
  const first = position.next;
  const to = run.plan.backfillTo;
  if (first > to) return;
  const started = performance.now();
  status.enter("backfill");
  status.setRange(first, to, first - 1);
  const handledBefore = status.handled;
  let through = first - 1;
  let since = 0;
  const maxPending = heapLimit() * PENDING_SHARE;
  const batches = watchedEvents(run, first, to, true);
  const waited = (what: "events" | "extras", ms: number) =>
    what === "events" ? (status.time.fetch += ms) : (status.time.extras += ms);
  for await (const [batch, pre] of ahead(
    run.anyInclude || run.anyBlock ? slices(batches, 2_000) : batches,
    (b) => prefetch(run, b.events),
    waited,
  )) {
    since += await handleBatch(run, through + 1, batch, pre);
    through = batch.through;
    status.range.through = through;
    if (signal.aborted) break;
    if (
      since >= FLUSH_EVENTS ||
      through === to ||
      (cache?.pendingBytes ?? 0) > FLUSH_BYTES ||
      run.store.pendingBytes > maxPending
    ) {
      await position.commit({ kind: "batch", through });
      since = 0;
    }
  }
  if (!signal.aborted) through = to;
  if (through !== (position.checkpoint ?? first - 1))
    await position.commit({ kind: "batch", through });
  cache?.untrack();
  if (signal.aborted) return;
  const calls = run.client.stats;
  const c = cache?.stats;
  status.note({
    kind: "backfill",
    handled: status.handled - handledBefore,
    seconds: secondsSince(started),
    cache: c && { ...c },
    reads: calls.calls,
    cachedReads: calls.cached,
    rpc: status.rpc && {
      calls: status.rpc.calls,
      throttled: status.rpc.throttled,
      rate: status.rate(),
    },
  });
}

async function handleBatch(
  run: Run,
  from: number,
  batch: Batch,
  { extras, headers }: Prefetched,
): Promise<number> {
  const fires = firesIn(run.blockSources, from, batch.through);
  const missing = fires.map((f) => f.number).filter((n) => !headers.has(n));
  if (missing.length > 0) for (const [n, h] of await blockHeaders(run, missing)) headers.set(n, h);
  let i = 0;
  const fireUntil = async (block: number) => {
    for (; i < fires.length && fires[i]!.number < block; i++) {
      await fire(run, fires[i]!.source, headers.get(fires[i]!.number)!);
    }
  };
  for (const e of batch.events) {
    await fireUntil(e.block_number!);
    await handle(run, e, extras, headers);
  }
  await fireUntil(batch.through + 1);
  return batch.events.length + fires.length;
}

function firesIn(
  blockSources: BlockSource[],
  from: number,
  to: number,
): { source: string; number: number }[] {
  const out: { source: string; number: number }[] = [];
  for (const b of blockSources) {
    const lo = Math.max(from, b.startBlock);
    const hi = Math.min(to, b.endBlock ?? to);
    for (
      let n = b.startBlock + Math.ceil((lo - b.startBlock) / b.interval) * b.interval;
      n <= hi;
      n += b.interval
    )
      out.push({ source: b.name, number: n });
  }
  return out.sort((x, y) => x.number - y.number);
}

/**
 * Cuts batches into slices of about `max` events, always at a block boundary (a checkpoint never falls inside a
 * block). Keeps memory small when every event brings its transaction and receipt.
 */
async function* slices(source: AsyncIterable<Batch>, max: number): AsyncGenerator<Batch> {
  for await (const batch of source) {
    let start = 0;
    while (batch.events.length - start > max) {
      let end = start + max;
      const block = batch.events[end - 1]!.block_number!;
      while (end < batch.events.length && batch.events[end]!.block_number === block) end++;
      if (end === batch.events.length) break;
      yield {
        events: batch.events.slice(start, end),
        through: batch.events[end]!.block_number! - 1,
      };
      start = end;
    }
    yield {
      events: start === 0 ? batch.events : batch.events.slice(start),
      through: batch.through,
    };
  }
}

/**
 * Yields each item with `prepare(item)`, preparing the next item while the caller handles this one. `waited` gets
 * the time the caller waited for the source and, after that, for `prepare`.
 */
async function* ahead<T, U>(
  source: AsyncIterable<T>,
  prepare: (item: T) => Promise<U>,
  waited: (what: "events" | "extras", ms: number) => void,
): AsyncGenerator<[T, U]> {
  let pending: Promise<[T, U]> | undefined;
  let t = performance.now();
  const ready = async (p: Promise<[T, U]>) => {
    const r = await p;
    const now = performance.now();
    waited("extras", now - t);
    return r;
  };
  for await (const item of source) {
    const now = performance.now();
    waited("events", now - t);
    t = now;
    const next = prepare(item).then((u): [T, U] => [item, u]);
    next.catch(() => {});
    if (pending !== undefined) {
      yield await ready(pending);
      t = performance.now();
    }
    pending = next;
  }
  if (pending !== undefined) yield await ready(pending);
}
