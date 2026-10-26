import { type EmittedEvent, getEvents } from "../rpc/methods.ts";
import { felt } from "../types/felt.ts";
import { sleep } from "../utils/sleep.ts";
import { wantedOf } from "./handle.ts";
import type { Run } from "./open.ts";

/** A watched event in a block not yet accepted on L2, decoded; no handler ran on it, and it may still change. */
export type PreConfirmedEvent = {
  contract: string;
  name: string;
  args: Record<string, unknown>;
  address: string;
  block: number;
  transaction: { hash: string; index: number };
  index: number;
};

/** What `GET /pre-confirmed` serves: the events after the indexed `head`, as of `at` (ms since the epoch). */
export type PreConfirmed = { head: number; at: number; events: PreConfirmedEvent[] };

const order = (a: EmittedEvent, b: EmittedEvent) =>
  a.block_number! - b.block_number! ||
  a.transaction_index - b.transaction_index ||
  a.event_index - b.event_index;

/** Every `pollMs` until `signal` aborts: the pre-confirmed events the watched streams match, into `run.preConfirmed`. */
export async function followPreConfirmed(run: Run, signal: AbortSignal): Promise<void> {
  let failed = "";
  while (!signal.aborted) {
    try {
      run.preConfirmed.snapshot = await snapshot(run);
      failed = "";
    } catch (e) {
      const message = (e as Error).message;
      if (message !== failed) run.status.note({ kind: "preConfirmed", error: message });
      failed = message;
    }
    await sleep(run.config.pollMs, signal);
  }
  run.preConfirmed.snapshot = undefined;
}

async function snapshot(run: Run): Promise<PreConfirmed> {
  const { sources } = run;
  const head = run.position.checkpoint ?? -1;
  const streams = [
    { addresses: sources.addresses, keys: sources.keys },
    ...sources.streams.filter((s) => s.to === undefined || s.to > head),
  ].filter((s) => s.addresses.length > 0 && s.keys[0]!.length > 0);
  const all = (await Promise.all(streams.map((s) => pages(run, s.addresses, s.keys)))).flat();
  all.sort(order);
  const events: PreConfirmedEvent[] = [];
  for (const [i, e] of all.entries()) {
    if (e.block_number === undefined || e.block_number <= head) continue;
    if (i > 0 && order(all[i - 1]!, e) === 0) continue;
    const wanted = wantedOf(run, e);
    if (wanted === undefined) continue;
    events.push({
      contract: wanted.w.contract,
      name: wanted.decoded.name,
      args: wanted.decoded.args,
      address: felt(e.from_address),
      block: e.block_number,
      transaction: { hash: felt(e.transaction_hash), index: e.transaction_index },
      index: e.event_index,
    });
  }
  return { head, at: Date.now(), events };
}

async function pages(run: Run, address: string[], keys: string[][]): Promise<EmittedEvent[]> {
  const filter = {
    from_block: "pre_confirmed" as const,
    to_block: "pre_confirmed" as const,
    address,
    keys,
  };
  const out: EmittedEvent[] = [];
  let token: string | undefined;
  do {
    const page = await getEvents(run.rpc, filter, run.endpoint.maxChunk, token);
    for (const e of page.events) out.push(e);
    token = page.continuation_token;
  } while (token !== undefined);
  return out;
}
