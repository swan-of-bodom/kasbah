import type { Config } from "../config/app.ts";

/** Where the run goes, fixed at startup from the config, `to` and the tip. */
export type Plan = {
  live: boolean;
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

export function planOf(config: Config, to: number | undefined, tip: number): Plan {
  const window = config.reorgWindow ?? 64;
  const backfillTo = to === undefined ? tip - window : Math.min(to, tip - window);
  const starts = [...Object.values(config.contracts), ...Object.values(config.blocks ?? {})].map(
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
