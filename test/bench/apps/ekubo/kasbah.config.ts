import { kasbah } from "kasbah";
import coreAbi from "./abis/Core.ts";

/** Ekubo Core's swaps, positions and fees into pools and candles: the workload behind the numbers in DESIGN.md. */
export default kasbah({
  network: "mainnet",
  rpc: process.env.KASBAH_RPC_URL!,
  ws: false,
  contracts: {
    Core: {
      abi: coreAbi,
      address: "0x5dd3d2f4429af886cd1a3b08289dbcea99a294197e9eb43b0e0325b4b",
      startBlock: 165387,
    },
  },
  cache: process.env.KASBAH_BENCH_CACHE !== "off",
});
