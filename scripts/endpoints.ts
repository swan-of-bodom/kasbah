/** Endpoints to benchmark: ALCHEMY from KASBAH_RPC_URL, plus free public ones. */
export function endpoints(): Record<string, string> {
  return {
    ...(process.env.KASBAH_RPC_URL ? { alchemy: process.env.KASBAH_RPC_URL } : {}),
    cartridge: "https://api.cartridge.gg/x/starknet/mainnet",
    publicnode: "https://starknet-rpc.publicnode.com",
  };
}
