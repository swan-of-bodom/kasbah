import { kasbah } from "kasbah";
import coreAbi from "./abis/Core.ts";

/** Ekubo Core's swaps, positions and fees into pools and candles: the workload `pnpm bench:app` measures. */
export default kasbah({
  // The simulated node answers its own chain id (test/bench/node.ts).
  network: process.env.KASBAH_BENCH_SIM === "1" ? undefined : "mainnet",
  rpc: process.env.KASBAH_RPC_URL!,
  ws: false,
  contracts: {
    Core: {
      abi: coreAbi,
      address: "0x5dd3d2f4429af886cd1a3b08289dbcea99a294197e9eb43b0e0325b4b",
      startBlock: Number(process.env.KASBAH_BENCH_FROM ?? 165387),
    },
  },
  // `--cache off` is for builds from before the cache was always on; a newer build refuses it.
  ...(process.env.KASBAH_BENCH_CACHE === "off" && { cache: false as never }),
  concurrency:
    process.env.KASBAH_BENCH_CONCURRENCY === undefined
      ? undefined
      : Number(process.env.KASBAH_BENCH_CONCURRENCY),
});
