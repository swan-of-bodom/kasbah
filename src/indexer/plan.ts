import type { Resolved } from "../config/resolve.ts";

/** Where the run goes, fixed at startup from the config, `to` and the tip. */
export type Plan = {
  live: boolean;
  /** Blocks between the last final one and the tip, at startup. */
  window: number;
  /** Final blocks: backfilled without a journal, cached. A `to` inside the reorg window stops at its edge. */
  backfillTo: number;
  /** Classes are known through here: the tip when following it (live blocks decode with the class active now). */
  classTo: number;
  /** The lowest start block: where indexing starts with nothing committed. */
  start: number;
  /** `to` was past `backfillTo`. */
  clamped: boolean;
};

/** `final`: the newest final block at `tip` (`Finality.finalAt`). */
export function planOf(
  config: Resolved,
  to: number | undefined,
  tip: number,
  final = tip - config.reorgWindow,
): Plan {
  const window = tip - final;
  const backfillTo = to === undefined ? final : Math.min(to, final);
  const starts = [...Object.values(config.contracts), ...Object.values(config.blocks)].map(
    (c) => c.startBlock,
  );
  return {
    live: to === undefined,
    window,
    backfillTo,
    classTo: to === undefined ? tip : backfillTo,
    start: Math.min(...starts),
    clamped: to !== undefined && to > backfillTo,
  };
}
