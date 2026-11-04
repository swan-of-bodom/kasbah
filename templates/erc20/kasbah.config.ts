import { kasbah } from "kasbah";
import erc20Abi from "./abis/ERC20.ts";

/** LORDS, the Realms token: every transfer and approval since its deployment, about 2.5M events. */
export default kasbah({
  network: "mainnet",
  rpc: process.env.KASBAH_RPC_URL!,
  ws: true,
  contracts: {
    LORDS: {
      abi: erc20Abi,
      address: "0x0124aeb495b947201f5fac96fd1138e326ad86195b98df6dec9009158a533b49",
      startBlock: 88_597,
    },
  },
  cache: true,
});
