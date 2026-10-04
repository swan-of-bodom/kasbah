import { RpcError, type RpcClient } from "../rpc/client.ts";
import { type BlockHeader, type EmittedEvent, getEvents, getHeaders } from "../rpc/methods.ts";

export type BlockRef = { number: number; hash: string };

export type LiveBlock = { number: number; hash: string; parent: string; timestamp: number; events: EmittedEvent[] };

export type FollowOptions = {
  rpc: RpcClient;
  address: string | string[];
  keys?: string[][];
  chunkSize: number;
  /** Last indexed block. */
  head: BlockRef;
  /** Hashes of the indexed blocks inside the reorg window, by number; kept up to date by the caller. */
  known: Map<number, string>;
  pollMs: number;
  /** Most blocks handled in one tick, when catching up. */
  maxBlocks?: number;
  signal: AbortSignal;
  onBlock: (block: LiveBlock) => Promise<void>;
  /** Runs before blocks `from..to` are fetched and indexed (the caller may change `address` and `keys` in place). */
  prepare?: (from: number, to: number) => Promise<void>;
  /** Called with the newest block both chains share; everything after it must be undone. */
  onReorg: (ancestor: BlockRef) => Promise<void>;
  log?: (line: string) => void;
};

const BLOCK_NOT_FOUND = 24;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });

/** A node behind a load balancer that hasn't seen a block yet: try again next tick. */
const lagging = (e: unknown) => e instanceof RpcError && e.code === BLOCK_NOT_FOUND;

async function eventsIn(o: FollowOptions, from: number, to: number): Promise<EmittedEvent[]> {
  // An empty address or key list would match every event on the chain.
  if ((Array.isArray(o.address) && o.address.length === 0) || (o.keys !== undefined && o.keys[0]?.length === 0)) return [];
  const filter = { from_block: { block_number: from }, to_block: { block_number: to }, address: o.address, keys: o.keys };
  const out: EmittedEvent[] = [];
  let token: string | undefined;
  do {
    const page = await getEvents(o.rpc, filter, o.chunkSize, token);
    for (const e of page.events) out.push(e);
    token = page.continuation_token;
  } while (token !== undefined);
  return out;
}

/** The newest block in `known` (at or below `from`) whose hash the chain still has. */
export async function findAncestor(rpc: RpcClient, from: number, known: Map<number, string>): Promise<BlockRef> {
  for (let n = from; known.has(n); n--) {
    const [header] = await getHeaders(rpc, [n], 1);
    if (header!.block_hash === known.get(n)) return { number: n, hash: header!.block_hash };
  }
  throw new Error(`reorg deeper than the ${known.size} blocks kept, below block ${from}`);
}

/**
 * Follows the chain from `head`: every tick reads the tip, then the headers and events of the new blocks by number.
 * Headers must link to the last indexed block; if the first one doesn't, walks back through `known` to the common
 * ancestor and reports a reorg. Anything else inconsistent (a lagging node, an event whose block hash isn't the
 * header's) is retried on the next tick, never indexed.
 */
export async function follow(o: FollowOptions): Promise<void> {
  const maxBlocks = o.maxBlocks ?? 100;
  let head = o.head;

  const ancestor = () => findAncestor(o.rpc, head.number, o.known);

  /** One poll. False when the tick learned nothing usable and should wait. */
  const tick = async (): Promise<boolean> => {
    const tip = await o.rpc.request<{ block_hash: string; block_number: number }>("starknet_blockHashAndNumber", []);
    if (tip.block_number < head.number || (tip.block_number === head.number && tip.block_hash === head.hash)) return false;
    const from = Math.min(head.number + 1, tip.block_number);
    const to = Math.min(tip.block_number, head.number + maxBlocks);
    const numbers = Array.from({ length: to - from + 1 }, (_, i) => from + i);
    await o.prepare?.(from, to);
    const [headers, events] = await Promise.all([getHeaders(o.rpc, numbers, 100), eventsIn(o, from, to)]);

    const first = headers[0]!;
    const forked = first.block_number === head.number + 1 ? first.parent_hash !== head.hash : first.block_hash !== head.hash;
    if (forked) {
      const a = await ancestor();
      o.log?.(`reorg: block ${head.number} (${head.hash}) replaced, back to ${a.number}`);
      await o.onReorg(a);
      head = a;
      return true;
    }
    if (first.block_number === head.number) headers.shift();

    const byBlock = new Map<number, { header: BlockHeader; events: EmittedEvent[] }>(headers.map((h) => [h.block_number, { header: h, events: [] }]));
    for (const [i, h] of headers.entries()) {
      if (i > 0 && h.parent_hash !== headers[i - 1]!.block_hash) return false;
    }
    for (const e of events) {
      const b = byBlock.get(e.block_number!);
      if (b === undefined) continue;
      if (e.block_hash !== undefined && e.block_hash !== b.header.block_hash) return false;
      b.events.push(e);
    }

    for (const { header: h, events } of byBlock.values()) {
      if (o.signal.aborted) return true;
      await o.onBlock({ number: h.block_number, hash: h.block_hash, parent: h.parent_hash, timestamp: h.timestamp, events });
      head = { number: h.block_number, hash: h.block_hash };
    }
    return true;
  };

  while (!o.signal.aborted) {
    let progressed: boolean;
    try {
      progressed = await tick();
    } catch (e) {
      if (!lagging(e)) throw e;
      progressed = false;
    }
    if (!progressed) await sleep(o.pollMs, o.signal);
  }
}
