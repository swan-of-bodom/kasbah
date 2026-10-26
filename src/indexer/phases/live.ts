import { getHeaders } from "../../rpc/methods.ts";
import { HeadSubscription } from "../../sync/heads.ts";
import { type BlockRef, findAncestor, follow, type LiveBlock } from "../../sync/live.ts";
import { felt } from "../../types/felt.ts";
import { type Child, children as created } from "../events.ts";
import { extras, fire, handle } from "../handle.ts";
import type { BlockSource, Run } from "../open.ts";
import type { Watched } from "../sources.ts";

/** Poll interval while the socket delivers heads: polling then only catches a head the socket missed. */
const SOCKET_POLL_MS = 15_000;

/**
 * Follows the head: a commit per block, with its undo journal, until the signal aborts. A run with an end (`to`)
 * instead marks itself done, once indexed through it.
 */
export async function live(run: Run): Promise<void> {
  if (!run.plan.live) {
    if (run.position.checkpoint === run.plan.backfillTo)
      await run.position.commit({ kind: "done" });
    return;
  }
  const { config, rpc, endpoint, sources, status, store, signal, closers, position } = run;
  const last = position.next - 1;
  const head = {
    number: last,
    hash: position.known.get(last) ?? (await getHeaders(rpc, [last], 1))[0]!.block_hash,
  };
  await position.commit({ kind: "follow", head });
  store.journal = true;
  status.enter("live");
  status.live.block = last;
  status.note({ kind: "following", block: last });
  const { pollMs } = config;
  const heads =
    config.ws === undefined ? undefined : new HeadSubscription(config.ws, (n) => status.note(n));
  if (heads !== undefined) {
    closers.push(() => heads.close());
    status.head = () => heads.last;
  }
  /** Children created in the blocks of the current tick, by block: committed with their block. */
  let children = new Map<number, Watched[]>();
  await follow({
    rpc,
    address: sources.addresses,
    keys: sources.keys,
    streams: sources.streams,
    chunkSize: endpoint.maxChunk,
    head,
    known: position.known,
    signal,
    pollMs,
    // With a socket up, a missed head costs at most 15 s; without, poll as usual.
    wait:
      heads === undefined
        ? undefined
        : (s) => heads.wait(heads.healthy ? Math.max(pollMs, SOCKET_POLL_MS) : pollMs, s),
    prepare: async (from, to) => {
      children = await discover(run, from, to);
      await sources.checkClasses(from, to);
    },
    onBlock: (block) => onBlock(run, block, children.get(block.number) ?? []),
    onReorg: (ancestor, replaced) => reorg(run, ancestor, replaced, false),
  });
}

/** At open, if it stopped while live: the blocks indexed last may have been reorged since (backfill trusts its start). */
export async function resume(run: Run, children: Child[]): Promise<void> {
  const { position, sources, plan } = run;
  const c = position.checkpoint;
  const hash = c === undefined ? undefined : position.known.get(c);
  if (c !== undefined && hash !== undefined) {
    const ancestor = await findAncestor(run.rpc, c, position.known);
    if (ancestor.number < c) await reorg(run, ancestor, { number: c, hash }, true);
  }
  // Children found by earlier runs, minus those whose creation that reorg undid.
  await Promise.all(
    children
      .filter((ch) => ch.block <= position.watermark)
      .map((ch) => sources.add(ch.contract, ch.address, ch.block, plan.classTo, true)),
  );
}

async function onBlock(run: Run, block: LiveBlock, children: Watched[]): Promise<void> {
  run.final = Math.max(run.final, block.number - run.plan.window);
  await run.sources.upgradesIn(block.events, block.number);
  const x = await extras(run, block.events);
  const headers = new Map([[block.number, block.header]]);
  for (const e of block.events) await handle(run, e, x, headers);
  for (const b of run.blockSources)
    if (firesAt(b, block.number)) await fire(run, b.name, block.header);
  await run.position.commit({ kind: "block", block, children });
}

async function reorg(
  run: Run,
  ancestor: BlockRef,
  replaced: BlockRef,
  stopped: boolean,
): Promise<void> {
  const { undone, forgotten } = await run.position.commit({ kind: "revert", to: ancestor });
  run.status.note({
    kind: "reorg",
    block: replaced.number,
    hash: felt(replaced.hash),
    ancestor: ancestor.number,
    rows: undone,
    children: forgotten,
    stopped,
  });
}

/**
 * Before blocks `from..to` are fetched: watches the children created in them at once (their events come in the same
 * fetch) and returns them by block, for the blocks' commits. Children of a tick that never committed (a reorg, a
 * lagging node) are dropped first.
 */
async function discover(run: Run, from: number, to: number): Promise<Map<number, Watched[]>> {
  const { sources, factories } = run;
  sources.removeChildrenAfter(from - 1);
  const byBlock = new Map<number, Watched[]>();
  if (factories.length === 0) return byBlock;
  for await (const batch of created(run, from, to, false)) {
    for (const c of batch.children) {
      const w = await sources.add(c.contract, c.address, c.block, to, true);
      if (w !== undefined) byBlock.set(c.block, [...(byBlock.get(c.block) ?? []), w]);
    }
  }
  return byBlock;
}

const firesAt = (b: BlockSource, n: number) =>
  n >= b.startBlock &&
  (b.endBlock === undefined || n <= b.endBlock) &&
  (n - b.startBlock) % b.interval === 0;
