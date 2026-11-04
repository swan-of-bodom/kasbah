import type { IndexedBlock } from "../config/app.ts";
import { type EmittedEvent, getHeaders } from "../rpc/methods.ts";
import { type Extras, fetchExtras } from "../sync/extras.ts";
import { type Block, blockOf } from "../types/block.ts";
import { canonical, type Felt, felt } from "../types/felt.ts";
import type { Receipt, Transaction } from "../types/transaction.ts";
import type { Run } from "./open.ts";
import type { Watched } from "./sources.ts";

export type Prefetched = { extras: Map<string, Extras>; headers: Map<number, Block> };

// A cached event's fields are unpacked on every read (`CachedEvent`): each is read once here.
function watchedOf(run: Run, e: EmittedEvent) {
  const { byAddress } = run.sources;
  const address = e.from_address;
  return byAddress.get(address) ?? byAddress.get(canonical(address));
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

/**
 * A handler's `event`. An instance of a class, not a literal: a literal with a getter cost ~1 µs per event to
 * build. `log` is a getter on the prototype, built only if read, so spreading an event leaves it out.
 */
class HandlerEvent {
  readonly contract: string;
  readonly name: string;
  readonly args: unknown;
  readonly address: Felt;
  readonly block: Block | { number: number; hash: Felt | undefined };
  readonly transaction: Partial<Transaction> & { hash: Felt; index: number | undefined };
  declare readonly receipt?: Receipt;
  readonly index: number | undefined;
  readonly #emitted: EmittedEvent;

  constructor(
    w: Watched,
    decoded: { name: string; args: unknown },
    block: HandlerEvent["block"],
    x: Extras | undefined,
    e: EmittedEvent,
  ) {
    this.contract = w.contract;
    this.name = decoded.name;
    this.args = decoded.args;
    this.address = w.padded;
    this.block = block;
    const hash = felt(e.transaction_hash);
    this.transaction =
      x?.transaction === undefined
        ? { hash, index: e.transaction_index }
        : { ...x.transaction, hash, index: e.transaction_index };
    if (x?.receipt !== undefined) this.receipt = x.receipt;
    this.index = e.event_index;
    this.#emitted = e;
  }

  get log(): { keys: Felt[]; data: Felt[] } {
    return { keys: this.#emitted.keys.map(felt), data: this.#emitted.data.map(felt) };
  }
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
  if (e.block_number! > (run.config.contracts[w.contract]!.endBlock ?? Infinity)) return;
  const decoded = w.decode(e.block_number!, e.keys, e.data);
  if (decoded === undefined) return;
  const name = `${w.contract}:${decoded.name}`;
  const handler = run.handlers.get(name);
  if (handler === undefined) return;
  if (run.sources.filterOf(w.contract, decoded.name)?.matches(decoded.args) === false) return;
  const event = new HandlerEvent(
    w,
    decoded,
    run.config.contracts[w.contract]!.include?.block
      ? headers.get(e.block_number!)!
      : {
          number: e.block_number!,
          hash: e.block_hash === undefined ? undefined : felt(e.block_hash),
        },
    extras.size === 0 ? undefined : extras.get(e.transaction_hash),
    e,
  );
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

/** The `setup` handler, if any, when nothing is committed yet: its writes commit with the first blocks. */
export async function setup(run: Run): Promise<void> {
  const handler = run.handlers.get("setup");
  if (handler === undefined || run.position.checkpoint !== undefined) return;
  run.client.current = { number: Math.max(0, run.plan.start - 1), hash: undefined };
  const t = performance.now();
  try {
    await handler({ context: run.context } as never);
  } catch (err) {
    throw new Error(`setup: ${(err as Error).message}`, { cause: err });
  }
  run.status.record("setup", performance.now() - t);
}

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
