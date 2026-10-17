import type { IndexedBlock } from "../config/app.ts";
import { type EmittedEvent, getHeaders } from "../rpc/methods.ts";
import { type Extras, fetchExtras } from "../sync/extras.ts";
import { type Block, blockOf } from "../types/block.ts";
import { felt } from "../types/felt.ts";
import type { Run } from "./open.ts";
import { canonical } from "./sources.ts";

/** What a batch's handlers need besides its events. */
export type Prefetched = { extras: Map<string, Extras>; headers: Map<number, Block> };

function watchedOf(run: Run, e: EmittedEvent) {
  const { byAddress } = run.sources;
  return byAddress.get(e.from_address) ?? byAddress.get(canonical(e.from_address));
}

function includeOf(run: Run, e: EmittedEvent) {
  const w = watchedOf(run, e);
  return w === undefined ? undefined : run.config.contracts[w.contract]!.include;
}

/** Transactions, receipts, and headers for `include.block`, for one batch of events. */
export async function prefetch(run: Run, events: EmittedEvent[]): Promise<Prefetched> {
  const blocks = run.anyBlock
    ? events.filter((e) => includeOf(run, e)?.block).map((e) => e.block_number!)
    : [];
  const [x, headers] = await Promise.all([
    extras(run, events),
    blocks.length > 0 ? blockHeaders(run, blocks) : new Map<number, Block>(),
  ]);
  return { extras: x, headers };
}

export function extras(run: Run, events: EmittedEvent[]): Promise<Map<string, Extras>> {
  if (!run.anyInclude) return Promise.resolve(new Map());
  return fetchExtras(run.rpc, events, (e) => includeOf(run, e), {
    cache: run.cache,
    isFinal: (b) => b <= run.final,
  });
}

/** Headers for block handlers: the cache's, then RPC (final ones saved to the shared cache, outside any commit). */
export async function blockHeaders(run: Run, numbers: number[]): Promise<Map<number, Block>> {
  const { cache, rpc } = run;
  const unique = [...new Set(numbers)];
  const found = (await cache?.headers(unique)) ?? new Map<number, Block>();
  const fetched = await getHeaders(
    rpc,
    unique.filter((n) => !found.has(n)),
    100,
  );
  await cache?.saveHeaders(fetched.filter((h) => h.block_number <= run.plan.backfillTo));
  for (const h of fetched) found.set(h.block_number, blockOf(h));
  return found;
}

/** Decodes `e` with its address's class at that block and runs its handler, if any. */
export async function handle(
  run: Run,
  e: EmittedEvent,
  extras: Map<string, Extras>,
  headers: Map<number, Block>,
): Promise<void> {
  const w = watchedOf(run, e);
  if (w === undefined || e.block_number! < w.from) return;
  const decoded = w.decode(e.block_number!, e.keys, e.data);
  if (decoded === undefined) return;
  const name = `${w.contract}:${decoded.name}`;
  const handler = run.handlers.get(name);
  if (handler === undefined) return;
  const x = extras.get(e.transaction_hash);
  const event = {
    contract: w.contract,
    name: decoded.name,
    args: decoded.args,
    address: felt(e.from_address),
    block: run.config.contracts[w.contract]!.include?.block
      ? headers.get(e.block_number!)!
      : {
          number: e.block_number!,
          hash: e.block_hash === undefined ? undefined : felt(e.block_hash),
        },
    transaction: { ...x?.transaction, hash: felt(e.transaction_hash), index: e.transaction_index },
    // Padded only if a handler reads it.
    get log() {
      return { keys: e.keys.map(felt), data: e.data.map(felt) };
    },
    ...(x?.receipt === undefined ? {} : { receipt: x.receipt }),
    index: e.event_index,
  };
  run.client.current = event.block;
  const t = performance.now();
  try {
    await handler({ event: event as never, context: run.context });
  } catch (err) {
    throw new Error(
      `${name} at block ${e.block_number}, tx ${e.transaction_hash}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  run.status.record(name, performance.now() - t);
}

/** Runs `source`'s block handler, if any, for `block`. */
export async function fire(run: Run, source: string, block: IndexedBlock["block"]): Promise<void> {
  const handler = run.handlers.get(`${source}:block`);
  if (handler === undefined) return;
  run.client.current = block;
  const t = performance.now();
  try {
    await handler({ event: { source, block } as never, context: run.context });
  } catch (err) {
    throw new Error(`${source}:block at block ${block.number}: ${(err as Error).message}`, {
      cause: err,
    });
  }
  run.status.record(`${source}:block`, performance.now() - t);
}
