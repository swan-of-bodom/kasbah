import { kasbah } from "kasbah";
import factoryAbi from "./abis/Factory.ts";
import pairAbi from "./abis/Pair.ts";

const FACTORY = "0x00dad44c139a476c7a17fc8141e6db680e9abc9f56fe249a105094c44382c2fd";
const START = 10_765;

/**
 * JediSwap v1 (Cairo 0): every pair its factory created, found as the factory emits `PairCreated`, with their swaps
 * and reserves. The factory and the pairs are proxies, so the ABIs are their implementations'.
 */
export default kasbah({
  network: "mainnet",
  rpc: process.env.KASBAH_RPC_URL!,
  ws: true,
  contracts: {
    Factory: { abi: factoryAbi, address: FACTORY, startBlock: START },
    Pair: {
      abi: pairAbi,
      factory: { address: FACTORY, abi: factoryAbi, event: "PairCreated", parameter: "pair" },
      startBlock: START,
    },
  },
  cache: true,
});
