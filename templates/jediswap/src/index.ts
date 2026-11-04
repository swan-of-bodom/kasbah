import app from "../kasbah.config.ts";
import { pair, swap } from "../kasbah.schema.ts";

/** A Cairo 0 felt as the 64-digit hex `event.address` has. */
const hexOf = (felt: bigint) => `0x${felt.toString(16).padStart(64, "0")}` as const;

app.on("Factory:PairCreated", async ({ event, context }) => {
  await context.db.insert(pair).values({
    address: hexOf(event.args.pair),
    token0: hexOf(event.args.token0),
    token1: hexOf(event.args.token1),
    createdAt: event.block.number,
    swapCount: 0,
    volume0: 0n,
    volume1: 0n,
    reserve0: 0n,
    reserve1: 0n,
  });
});

app.on("Pair:Swap", async ({ event, context }) => {
  const a = event.args;
  await context.db.insert(swap).values({
    id: `${event.transaction.hash}:${event.index}`,
    pairAddress: event.address,
    block: event.block.number,
    sender: hexOf(a.sender),
    amount0In: a.amount0In,
    amount1In: a.amount1In,
    amount0Out: a.amount0Out,
    amount1Out: a.amount1Out,
  });
  await context.db.update(pair, { address: event.address }).set((p) => ({
    swapCount: p.swapCount + 1,
    volume0: p.volume0 + a.amount0In + a.amount0Out,
    volume1: p.volume1 + a.amount1In + a.amount1Out,
  }));
});

app.on("Pair:Sync", async ({ event, context }) => {
  await context.db
    .update(pair, { address: event.address })
    .set({ reserve0: event.args.reserve0, reserve1: event.args.reserve1 });
});
