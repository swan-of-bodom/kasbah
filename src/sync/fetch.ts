import type { RpcClient } from "../rpc/client.ts";
import { type EmittedEvent, getEvents } from "../rpc/methods.ts";

export type FetchEventsOptions = {
  rpc: RpcClient;
  address: string | string[];
  keys?: string[][];
  /** Inclusive block range. */
  from: number;
  to: number;
  chunkSize: number;
  /** Windows paginating at once. */
  concurrency: number;
  /** Initial window size in blocks; dense windows are split while they run. */
  windowSize: number;
  /** Smallest remaining range worth splitting off. */
  minSplit?: number;
  /** Called with each page's events inside one window, in chain order within that window. */
  onEvents: (events: EmittedEvent[], window: { from: number; stop: number }) => void;
};

export type FetchStats = { events: number; pages: number; windows: number; splits: number };

type Window = { from: number; to: number; stop: number };

const tokenBlock = (token: string): number | undefined => {
  const n = Number(token.slice(0, token.indexOf("-")));
  return Number.isSafeInteger(n) ? n : undefined;
};

/**
 * Fetches every matching event in a block range: windows paginate in parallel, each sequentially with its
 * continuation token. When a worker goes idle, a running window hands off the second half of what it has left:
 * the new window starts fresh at the midpoint, and the old one keeps its token (same filter) and stops there.
 */
export async function fetchEvents(o: FetchEventsOptions): Promise<FetchStats> {
  const stats: FetchStats = { events: 0, pages: 0, windows: 0, splits: 0 };
  const minSplit = o.minSplit ?? 64;
  const queue: Window[] = [];
  for (let from = o.from; from <= o.to; from += o.windowSize) {
    const to = Math.min(o.to, from + o.windowSize - 1);
    queue.push({ from, to, stop: to + 1 });
  }

  const idle: ((w: Window | undefined) => void)[] = [];
  let busy = 0;

  const push = (w: Window) => {
    const waiter = idle.shift();
    if (waiter) {
      busy++;
      waiter(w);
    } else queue.push(w);
  };

  /** Hands out a window and counts it busy right away, so other workers never see a false "all done". */
  const take = (): Promise<Window | undefined> => {
    const w = queue.shift();
    if (w !== undefined) {
      busy++;
      return Promise.resolve(w);
    }
    if (busy === 0) return Promise.resolve(undefined);
    return new Promise((r) => idle.push(r));
  };

  const run = async (w: Window) => {
    stats.windows++;
    const filter = { from_block: { block_number: w.from }, to_block: { block_number: w.to }, address: o.address, keys: o.keys };
    let token: string | undefined;
    for (;;) {
      const page = await getEvents(o.rpc, filter, o.chunkSize, token);
      stats.pages++;
      let events = page.events;
      const last = events.at(-1);
      if (last !== undefined && last.block_number! >= w.stop) events = events.filter((e) => e.block_number! < w.stop);
      if (events.length > 0) {
        stats.events += events.length;
        o.onEvents(events, { from: w.from, stop: w.stop });
      }
      token = page.continuation_token;
      if (token === undefined) return;
      const at = tokenBlock(token);
      if (at === undefined) continue;
      if (at >= w.stop) return;
      if (idle.length > 0 && w.stop - at >= minSplit) {
        const mid = at + Math.floor((w.stop - at) / 2);
        push({ from: mid, to: w.stop - 1, stop: w.stop });
        w.stop = mid;
        stats.splits++;
      }
    }
  };

  const worker = async () => {
    for (;;) {
      const w = await take();
      if (w === undefined) return;
      try {
        await run(w);
      } finally {
        busy--;
        if (busy === 0 && queue.length === 0) for (const r of idle.splice(0)) r(undefined);
      }
    }
  };

  await Promise.all(Array.from({ length: o.concurrency }, worker));
  return stats;
}
