import type { Abi } from "../abi/abi.ts";
import { compileFunction } from "../abi/functions.ts";
import { rawSelector } from "../abi/selector.ts";
import type { FunctionArgs, FunctionName, FunctionResult } from "../abi/types.ts";
import type { EventCache } from "../db/cache.ts";
import { type RpcClient, RpcError } from "../rpc/client.ts";
import { type Felt, felt, unpadded } from "../types/felt.ts";

export type ReadParameters<TAbi extends Abi, N extends FunctionName<TAbi>> = {
  abi: TAbi;
  address: string;
  functionName: N;
  /** State at the end of this block. Default: the block being indexed. */
  block?: number;
} & (Record<string, never> extends FunctionArgs<TAbi, N>
  ? { args?: FunctionArgs<TAbi, N> }
  : { args: FunctionArgs<TAbi, N> });

export type CallParameters = {
  address: string;
  /** Function name, or its selector. */
  entrypoint: string;
  calldata?: string[];
  block?: number;
};

/** Contract reads for handlers, pinned to the block being indexed. */
export type Client = {
  read<const TAbi extends Abi, const N extends FunctionName<TAbi>>(
    p: ReadParameters<TAbi, N>,
  ): Promise<FunctionResult<TAbi, N>>;
  /** Raw `starknet_call`: calldata in, result felts out. */
  call(p: CallParameters): Promise<Felt[]>;
};

export type CallClientOptions = {
  /** Blocks that can no longer be reorged: their results are cached. */
  isFinal: (block: number) => boolean;
  /** Persistent results, when the raw-event cache is on. */
  cache?: EventCache;
  /** In-memory results kept. Default 100k. */
  maxEntries?: number;
};

const canonical = (felt: string) => `0x${BigInt(felt).toString(16)}`;

export class CallClient implements Client {
  /** The block being indexed: the default for reads, and the hash pins non-final reads. */
  current: { number: number; hash: string | undefined } = { number: 0, hash: undefined };
  readonly stats = { calls: 0, cached: 0 };
  readonly #rpc: RpcClient;
  readonly #options: CallClientOptions;
  readonly #memory = new Map<string, string[]>();
  readonly #max: number;

  constructor(rpc: RpcClient, options: CallClientOptions) {
    this.#rpc = rpc;
    this.#options = options;
    this.#max = options.maxEntries ?? 100_000;
  }

  read = async <const TAbi extends Abi, const N extends FunctionName<TAbi>>(
    p: ReadParameters<TAbi, N>,
  ): Promise<FunctionResult<TAbi, N>> => {
    const f = compileFunction(p.abi, p.functionName);
    const felts = await this.#call(p.address, f.selector, f.encode(p.args), p.block, f.name);
    return f.decode(felts) as FunctionResult<TAbi, N>;
  };

  call = async (p: CallParameters): Promise<Felt[]> =>
    (
      await this.#call(
        p.address,
        p.entrypoint.startsWith("0x") ? canonical(p.entrypoint) : rawSelector(p.entrypoint),
        (p.calldata ?? []).map(canonical),
        p.block,
        p.entrypoint,
      )
    ).map(felt);

  async #call(
    address: string,
    entrypoint: string,
    calldata: string[],
    at: number | undefined,
    label: string,
  ): Promise<string[]> {
    const block = at ?? this.current.number;
    const final = this.#options.isFinal(block);
    const contract = canonical(address);
    const key = final ? `${contract}:${entrypoint}:${calldata.join(",")}:${block}` : undefined;
    if (key !== undefined) {
      const hit =
        this.#memory.get(key) ??
        (await this.#options.cache?.getCall(contract, entrypoint, calldata, block));
      if (hit !== undefined) {
        this.stats.cached++;
        this.#remember(key, hit);
        return hit;
      }
    }
    // Not final: pin by hash, so a reorged or lagging node can't answer for another block at the same height.
    // Handlers see padded hashes; the node takes its own form.
    const blockId =
      !final && at === undefined && this.current.hash !== undefined
        ? { block_hash: unpadded(this.current.hash) }
        : { block_number: block };
    this.stats.calls++;
    let result: string[];
    try {
      result = (
        await this.#rpc.request<string[]>("starknet_call", {
          request: { contract_address: contract, entry_point_selector: entrypoint, calldata },
          block_id: blockId,
        })
      ).map(canonical);
    } catch (err) {
      if (err instanceof RpcError)
        throw new Error(`call ${label} on ${contract} at block ${block}: ${err.message}`, {
          cause: err,
        });
      throw err;
    }
    if (key !== undefined) {
      this.#remember(key, result);
      this.#options.cache?.rememberCall(contract, entrypoint, calldata, block, result);
    }
    return result;
  }

  #remember(key: string, result: string[]) {
    this.#memory.delete(key);
    this.#memory.set(key, result);
    if (this.#memory.size > this.#max) this.#memory.delete(this.#memory.keys().next().value!);
  }
}
