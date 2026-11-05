import { kasbah } from "kasbah";

/**
 * Pragma's ETH, BTC and STRK prices in USD, read from its oracle about once an hour (a block every ~1.7 s) from
 * block 16M (6 October 2026). No events: a block handler reads the oracle at each tick. Lower `startBlock` for a
 * longer history (each tick is one more round trip on a first run), or `interval` for finer prices.
 */
export default kasbah({
  network: "mainnet",
  rpc: process.env.KASBAH_RPC_URL!,
  ws: true,
  contracts: {},
  blocks: {
    Prices: { interval: 2_000, startBlock: 16_000_000 },
  },
});
