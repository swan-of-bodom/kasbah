import { kasbah } from "kasbah";
import coreAbi from "./abis/Core.ts";

/** Ekubo's Core from its deployment: every pool, with its swaps and its state after the last one. */
export default kasbah({
  network: "mainnet",
  rpc: process.env.KASBAH_RPC_URL!,
  ws: true,
  contracts: {
    Core: {
      abi: coreAbi,
      address: "0x00000005dd3d2f4429af886cd1a3b08289dbcea99a294197e9eb43b0e0325b4b",
      startBlock: 165_392,
    },
  },
});
