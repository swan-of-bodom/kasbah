import { ConfigError } from "./errors.ts";

/** Starknet's public networks and the chain id `starknet_chainId` answers on each. */
export const NETWORKS = {
  mainnet: "0x534e5f4d41494e",
  sepolia: "0x534e5f5345504f4c4941",
} as const;

export type Network = keyof typeof NETWORKS;

/** The network's name, or the chain id as the short string it encodes (`SN_DEVNET`) when it is none of them. */
export function networkName(chainId: string): string {
  const id = BigInt(chainId);
  for (const [name, c] of Object.entries(NETWORKS)) if (BigInt(c) === id) return name;
  const hex = id.toString(16);
  const text = Buffer.from(hex.length % 2 === 0 ? hex : `0${hex}`, "hex").toString("latin1");
  return /^[\x20-\x7e]+$/.test(text) ? text : chainId;
}

/** Refuses an RPC on another chain than the config's `network`. */
export function checkNetwork(network: Network, chainId: string): void {
  if (BigInt(chainId) !== BigInt(NETWORKS[network]))
    throw new ConfigError(
      `network is ${network} but the RPC is on ${networkName(chainId)}: check the RPC URL`,
    );
}
