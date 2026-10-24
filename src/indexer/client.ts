import type { Abi } from "../abi/abi.ts";
import { compileFunction } from "../abi/functions.ts";
import { rawSelector } from "../abi/selector.ts";
import type { FunctionArgs, FunctionName, FunctionResult } from "../abi/types.ts";
import type { EventCache } from "../db/cache.ts";
import { type RpcClient, RpcError } from "../rpc/client.ts";
import { canonical, type Felt, felt, unpadded } from "../types/felt.ts";

/** One function on one contract, with its arguments. */
export type ContractFunction<TAbi extends Abi, N extends FunctionName<TAbi>> = {
  abi: TAbi;
  address: string;
  functionName: N;
} & (Record<string, never> extends FunctionArgs<TAbi, N>
  ? { args?: FunctionArgs<TAbi, N> }
  : { args: FunctionArgs<TAbi, N> });

export type ReadContractParameters<
  TAbi extends Abi,
  N extends FunctionName<TAbi>,
> = ContractFunction<TAbi, N> & {
  /** State at the end of this block. Default: the block being indexed. */
  block?: number;
};

/** Each entry checked against its own ABI. */
export type ContractFunctions<T extends readonly unknown[]> = {
  [K in keyof T]: T[K] extends { abi: infer A extends Abi; functionName: infer N }
    ? N extends FunctionName<A>
      ? ContractFunction<A, N>
      : ContractFunction<A, FunctionName<A>>
    : ContractFunction<Abi, string>;
};

/** One read of `readContracts` with `allowFailure`: its result, or why it failed. */
export type ReadResult<R> =
  | { status: "success"; result: R; error?: undefined }
  | { status: "failure"; error: Error; result?: undefined };

export type ReadContractsResults<T extends readonly unknown[], F extends boolean> = {
  -readonly [K in keyof T]: T[K] extends { abi: infer A extends Abi; functionName: infer N }
    ? N extends FunctionName<A>
      ? F extends true
        ? ReadResult<FunctionResult<A, N>>
        : FunctionResult<A, N>
      : never
    : never;
};

export type ReadContractsParameters<T extends readonly unknown[], F extends boolean> = {
  contracts: T & ContractFunctions<T>;
  /** Default true: each entry is a `ReadResult`. False: plain results, and the first failure rejects. */
  allowFailure?: F;
  /** State at the end of this block, for every read. Default: the block being indexed. */
  block?: number;
};

export type CallParameters = {
  address: string;
  /** Function name, or its selector. */
  entrypoint: string;
  calldata?: string[];
  block?: number;
};

/** Contract reads for handlers, pinned to the block being indexed. */
export type Client = {
  readContract<const TAbi extends Abi, const N extends FunctionName<TAbi>>(
    p: ReadContractParameters<TAbi, N>,
  ): Promise<FunctionResult<TAbi, N>>;
  /**
   * Several reads, like viem's `multicall`: the ones not cached go out in one JSON-RPC batch (one round trip; the
   * provider still bills each call).
   */
  readContracts<const T extends readonly unknown[], const F extends boolean = true>(
    p: ReadContractsParameters<T, F>,
  ): Promise<ReadContractsResults<T, F>>;
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

type Target = {
  contract: string;
  entrypoint: string;
  calldata: string[];
  block: number;
  blockId: { block_hash: string } | { block_number: number };
  key: string | undefined;
  label: string;
};

/** Call results kept in memory, oldest dropped first (the cache, when on, keeps more in Postgres). */
const MAX_ENTRIES = 100_000;

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
    this.#max = options.maxEntries ?? MAX_ENTRIES;
  }

  readContract = async <const TAbi extends Abi, const N extends FunctionName<TAbi>>(
    p: ReadContractParameters<TAbi, N>,
  ): Promise<FunctionResult<TAbi, N>> => {
    const f = compileFunction(p.abi, p.functionName);
    const [r] = await this.#calls([
      this.#target(p.address, f.selector, f.encode(p.args), p.block, f.name),
    ]);
    if (r instanceof Error) throw r;
    return f.decode(r!) as FunctionResult<TAbi, N>;
  };

  readContracts = async <const T extends readonly unknown[], const F extends boolean = true>(
    p: ReadContractsParameters<T, F>,
  ): Promise<ReadContractsResults<T, F>> => {
    const allowFailure = p.allowFailure !== false;
    const failed = (error: unknown) => {
      if (!allowFailure) throw error;
      return { status: "failure" as const, error: error as Error };
    };
    const prepared = (p.contracts as readonly ContractFunction<Abi, string>[]).map((c) => {
      try {
        const f = compileFunction(c.abi, c.functionName);
        return {
          f,
          target: this.#target(c.address, f.selector, f.encode(c.args), p.block, f.name),
        };
      } catch (error) {
        return { error };
      }
    });
    if (!allowFailure) for (const x of prepared) if (x.target === undefined) throw x.error;
    const answers = await this.#calls(
      prepared.flatMap((x) => (x.target === undefined ? [] : [x.target])),
    );
    let i = 0;
    const results = prepared.map((x) => {
      if (x.target === undefined) return failed(x.error);
      const a = answers[i++]!;
      if (a instanceof Error) return failed(a);
      try {
        const result = x.f.decode(a);
        return allowFailure ? { status: "success" as const, result } : result;
      } catch (error) {
        return failed(error);
      }
    });
    return results as ReadContractsResults<T, F>;
  };

  call = async (p: CallParameters): Promise<Felt[]> => {
    const entrypoint = p.entrypoint.startsWith("0x")
      ? canonical(p.entrypoint)
      : rawSelector(p.entrypoint);
    const [r] = await this.#calls([
      this.#target(p.address, entrypoint, (p.calldata ?? []).map(canonical), p.block, p.entrypoint),
    ]);
    if (r instanceof Error) throw r;
    return r!.map(felt);
  };

  /** Where a call goes: the block it reads, as the node is told it, and its cache key when the block is final. */
  #target(
    address: string,
    entrypoint: string,
    calldata: string[],
    at: number | undefined,
    label: string,
  ): Target {
    const block = at ?? this.current.number;
    const final = this.#options.isFinal(block);
    const contract = canonical(address);
    // Not final: pin by hash, so a reorged or lagging node can't answer for another block at the same height.
    // Handlers see padded hashes; the node takes its own form.
    const blockId =
      !final && at === undefined && this.current.hash !== undefined
        ? { block_hash: unpadded(this.current.hash) }
        : { block_number: block };
    const key = final ? `${contract}:${entrypoint}:${calldata.join(",")}:${block}` : undefined;
    return { contract, entrypoint, calldata, block, blockId, key, label };
  }

  /**
   * Each call's result felts, in order: from memory or the cache when final, the rest in one batch. A call the node
   * refuses is its `Error` in place; a request that keeps failing rejects.
   */
  async #calls(targets: Target[]): Promise<(string[] | Error)[]> {
    const out: (string[] | Error | undefined)[] = await Promise.all(
      targets.map((t) => this.#cached(t)),
    );
    const missing = targets.flatMap((_, i) => (out[i] === undefined ? [i] : []));
    if (missing.length === 0) return out as string[][];
    this.stats.calls += missing.length;
    const describe = (t: Target) => `call ${t.label} on ${t.contract} at block ${t.block}`;
    let answers: unknown[];
    try {
      answers = await this.#rpc.batch<unknown[]>(
        missing.map((i) => {
          const t = targets[i]!;
          return {
            method: "starknet_call",
            params: {
              request: {
                contract_address: t.contract,
                entry_point_selector: t.entrypoint,
                calldata: t.calldata,
              },
              block_id: t.blockId,
            },
          };
        }),
        { settle: true },
      );
    } catch (err) {
      if (!(err instanceof RpcError)) throw err;
      const what =
        missing.length === 1 ? describe(targets[missing[0]!]!) : `${missing.length} calls`;
      throw new Error(`${what}: ${err.message}`, { cause: err });
    }
    for (const [j, i] of missing.entries()) {
      const t = targets[i]!;
      const a = answers[j];
      if (a instanceof RpcError) {
        out[i] = new Error(`${describe(t)}: ${a.message}`, { cause: a });
        continue;
      }
      const result = (a as string[]).map(canonical);
      if (t.key !== undefined) {
        this.#remember(t.key, result);
        this.#options.cache?.rememberCall(t.contract, t.entrypoint, t.calldata, t.block, result);
      }
      out[i] = result;
    }
    return out as (string[] | Error)[];
  }

  async #cached(t: Target): Promise<string[] | undefined> {
    if (t.key === undefined) return undefined;
    const hit =
      this.#memory.get(t.key) ??
      (await this.#options.cache?.getCall(t.contract, t.entrypoint, t.calldata, t.block));
    if (hit === undefined) return undefined;
    this.stats.cached++;
    this.#remember(t.key, hit);
    return hit;
  }

  #remember(key: string, result: string[]) {
    this.#memory.delete(key);
    this.#memory.set(key, result);
    if (this.#memory.size > this.#max) this.#memory.delete(this.#memory.keys().next().value!);
  }
}
