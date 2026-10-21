import { ConfigError } from "../config/errors.ts";
import { type RpcClient, RpcError } from "./client.ts";
import { getEvents, specVersion } from "./methods.ts";

export type Endpoint = {
  spec: string;
  node: "pathfinder" | "juno" | "unknown";
  nodeVersion?: string;
  /** Largest accepted `chunk_size` for `starknet_getEvents`. */
  maxChunk: number;
  /** Blocks one `getEvents` call scans before returning a token, `undefined` if unbounded. */
  scanLimit?: number;
};

const PAGE_SIZE_TOO_BIG = 31;
/** Blocks the probe scans for an address with no events: past any node's scan cap. */
const EMPTY_SPAN = 300_000;
/** Page sizes tried, largest first: the caps of Juno, Pathfinder and Madara. */
const CHUNK_SIZES = [10_240, 1_024, 1_000];
/** Pathfinder's default page and scan caps, which give away a hosted Pathfinder that hides its version. */
const PATHFINDER_CHUNK = 1_024;
const PATHFINDER_SCAN = 81_920;

async function tryRequest<T>(
  rpc: RpcClient,
  method: string,
  params: unknown,
): Promise<T | undefined> {
  try {
    return await rpc.request<T>(method, params);
  } catch (e) {
    if (e instanceof RpcError) return undefined;
    throw e;
  }
}

/** Finds what an endpoint actually enforces. A handful of cheap calls; run once per endpoint. */
export async function probe(rpc: RpcClient): Promise<Endpoint> {
  const spec = await specVersion(rpc);
  if (!spec.startsWith("0.10."))
    throw new ConfigError(`endpoint serves spec ${spec}, kasbah needs 0.10.x`);

  const pathfinder = await tryRequest<string>(rpc, "pathfinder_version", []);
  const juno =
    pathfinder === undefined ? await tryRequest<string>(rpc, "juno_version", []) : undefined;
  const node = pathfinder !== undefined ? "pathfinder" : juno !== undefined ? "juno" : "unknown";

  // An address with no events over 300k blocks: a capped node returns an empty page and a token at its cap.
  const nothing = {
    from_block: { block_number: 0 },
    to_block: { block_number: EMPTY_SPAN },
    address: "0x1",
  };
  let maxChunk = 0;
  let scanLimit: number | undefined;
  for (const size of CHUNK_SIZES) {
    try {
      const page = await getEvents(rpc, nothing, size);
      maxChunk = size;
      if (page.continuation_token !== undefined)
        scanLimit = Number(page.continuation_token.split("-")[0]);
      break;
    } catch (e) {
      if (!(e instanceof RpcError) || e.code !== PAGE_SIZE_TOO_BIG) throw e;
    }
  }
  if (maxChunk === 0) throw new ConfigError("endpoint rejects every chunk_size tried");

  // Hosted Pathfinder (Alchemy, Cartridge) hides pathfinder_version; its defaults give it away.
  const inferred =
    node === "unknown" && maxChunk === PATHFINDER_CHUNK && scanLimit === PATHFINDER_SCAN
      ? "pathfinder"
      : node;
  return { spec, node: inferred, nodeVersion: pathfinder ?? juno, maxChunk, scanLimit };
}
