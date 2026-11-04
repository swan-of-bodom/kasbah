import type { RpcEndpoint } from "../rpc/client.ts";
import { ConfigError } from "./errors.ts";

/** One RPC URL, the same with a cap on its calls per second, or several. */
export type RpcConfig = string | RpcEndpoint | readonly (string | RpcEndpoint)[];

/**
 * Several RPCs: each request goes to the one that can take it soonest, the fastest of those, and a retry goes to
 * another. `maxRequestsPerSecond` caps one (JSON-RPC calls; each in a batch counts).
 */
export const loadBalance = (endpoints: readonly (string | RpcEndpoint)[]): RpcConfig => endpoints;

export function endpointsOf(rpc: RpcConfig): RpcEndpoint[] {
  const list = (typeof rpc === "string" || !Array.isArray(rpc) ? [rpc] : rpc) as (
    | string
    | RpcEndpoint
  )[];
  if (list.length === 0) throw new ConfigError("rpc: no URL");
  return list.map((e) => {
    const endpoint = typeof e === "string" ? { url: e } : e;
    if (!/^https?:\/\//.test(endpoint.url ?? ""))
      throw new ConfigError(`rpc: ${JSON.stringify(endpoint.url)} is not an http(s) URL`);
    const max = endpoint.maxRequestsPerSecond;
    if (max !== undefined && !(max > 0))
      throw new ConfigError(`rpc: maxRequestsPerSecond must be above 0 (${endpoint.url})`);
    return endpoint;
  });
}
