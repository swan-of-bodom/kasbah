import type { Abi } from "./abi/abi.ts";
import { abiEvents, createDecoder } from "./abi/events.ts";
import { type ClassSpan, classHistory, createHistoricalDecoder, type Decode } from "./abi/history.ts";
import { selector } from "./abi/selector.ts";
import type { RpcClient } from "./rpc/client.ts";

export const canonical = (address: string) => `0x${BigInt(address).toString(16)}`;

/** One address being indexed: a configured contract, or a child its factory created. */
export type Watched = {
  contract: string;
  address: string;
  /** First block indexed: the contract's start block, or the block a child was created in. */
  from: number;
  /** Set for factory children. */
  child: boolean;
  spans: (ClassSpan & { abi: Abi })[];
  decode: ReturnType<typeof createHistoricalDecoder>;
  /** Classes are known up to this block. */
  checked: number;
};

export type ContractSource = {
  name: string;
  abi: Abi;
  startBlock: number;
  /** Events with a handler. */
  handled: Set<string>;
};

/** Above this many addresses, live class checks read each block's state diff instead of asking per address. */
const PER_ADDRESS_CHECKS = 100;

type StateUpdate = { state_diff: { replaced_classes: { contract_address: string; class_hash: string }[] } };

/**
 * Everything the fetcher watches: `addresses` and `keys` (shared with the fetchers, changed in place), each
 * address's class history and decoder.
 */
export class Sources {
  readonly addresses: string[] = [];
  /** `keys` filter: handled selectors at position 0. */
  readonly keys: string[][] = [[]];
  readonly byAddress = new Map<string, Watched>();
  readonly #rpc: RpcClient;
  readonly #contracts = new Map<string, ContractSource>();
  readonly #abis = new Map<string, Promise<Abi>>();
  readonly #decoders = new WeakMap<Abi, Decode>();
  readonly #reported = new Set<string>();
  readonly #log: (line: string) => void;

  constructor(rpc: RpcClient, contracts: ContractSource[], log: (line: string) => void) {
    this.#rpc = rpc;
    for (const c of contracts) this.#contracts.set(c.name, c);
    this.#log = log;
  }

  abiOf(classHash: string): Promise<Abi> {
    let abi = this.#abis.get(classHash);
    if (abi === undefined) {
      abi = this.#rpc
        .request<{ abi: string | Abi }>("starknet_getClass", { block_id: "latest", class_hash: classHash })
        .then((cls) => (typeof cls.abi === "string" ? JSON.parse(cls.abi) : cls.abi) as Abi);
      this.#abis.set(classHash, abi);
    }
    return abi;
  }

  #decoderFor = (abi: Abi): Decode => {
    let d = this.#decoders.get(abi);
    if (d === undefined) {
      d = createDecoder(abi);
      this.#decoders.set(abi, d);
    }
    return d;
  };

  async #withAbis(spans: ClassSpan[]) {
    return Promise.all(spans.map(async (s) => ({ ...s, abi: await this.abiOf(s.classHash) })));
  }

  /** Adds class spans to an address: new handled selectors join the filter, unknown event names are reported. */
  async #extend(w: Watched, spans: ClassSpan[]) {
    const c = this.#contracts.get(w.contract)!;
    const configured = new Set(abiEvents(c.abi).map((e) => e.name));
    for (const s of await this.#withAbis(spans)) {
      const missing: string[] = [];
      for (const e of abiEvents(s.abi)) {
        if (c.handled.has(e.name) && !this.keys[0]!.includes(e.selectors[0]!)) this.keys[0]!.push(e.selectors[0]!);
        if (!configured.has(e.name)) missing.push(e.name);
      }
      if (missing.length > 0 && !this.#reported.has(`${c.name}:${s.classHash}`)) {
        this.#reported.add(`${c.name}:${s.classHash}`);
        this.#log(`${c.name}: class ${s.classHash} emits events not in the configured ABI, they are skipped: ${missing.join(", ")}`);
      }
      w.spans.push(s);
    }
    w.decode = createHistoricalDecoder(w.spans, this.#decoderFor);
  }

  /**
   * Watches `address` from block `from`, its classes known up to `to`. Configured contracts get a full class
   * history; children are probed at creation and at `to`, and bisected only if those differ.
   */
  async add(contract: string, address: string, from: number, to: number, child: boolean): Promise<Watched | undefined> {
    const a = canonical(address);
    if (this.byAddress.has(a)) return undefined;
    const spans = await classHistory(this.#rpc, a, from, Math.max(from, to), child ? Number.MAX_SAFE_INTEGER : undefined);
    if (spans.length === 0) throw new Error(`${contract}: nothing deployed at ${a} by block ${to}`);
    const w: Watched = { contract, address: a, from, child, spans: [], decode: createHistoricalDecoder([]), checked: Math.max(from, to) };
    await this.#extend(w, spans);
    this.byAddress.set(a, w);
    this.addresses.push(a);
    return w;
  }

  /** Forgets children created after `block` (their creation was reorged away, or never indexed). */
  removeChildrenAfter(block: number): string[] {
    const removed: string[] = [];
    for (const [a, w] of this.byAddress) {
      if (w.child && w.from > block) {
        this.byAddress.delete(a);
        removed.push(a);
      }
    }
    if (removed.length > 0) {
      const gone = new Set(removed);
      const kept = this.addresses.filter((a) => !gone.has(a));
      this.addresses.splice(0, this.addresses.length, ...kept);
    }
    return removed;
  }

  /**
   * Before live blocks `from..to` are indexed: finds class replacements among watched addresses. Few addresses: one
   * batched `getClassHashAt(to)`, bisecting only a changed one. Many: each block's `replaced_classes`.
   */
  async checkClasses(from: number, to: number): Promise<void> {
    const due = [...this.byAddress.values()].filter((w) => w.checked < to);
    if (due.length === 0) return;
    if (due.length <= PER_ADDRESS_CHECKS) {
      const current = await this.#rpc.batch<string[]>(
        due.map((w) => ({ method: "starknet_getClassHashAt", params: { block_id: { block_number: to }, contract_address: w.address } })),
      );
      await Promise.all(due.map(async (w, i) => {
        if (current[i] !== w.spans.at(-1)!.classHash) {
          const changes = (await classHistory(this.#rpc, w.address, w.checked, to, Number.MAX_SAFE_INTEGER)).slice(1);
          this.#log(`${w.contract} ${w.address}: class replaced at block ${changes.map((s) => `${s.from} (${s.classHash})`).join(", ")}`);
          await this.#extend(w, changes);
        }
        w.checked = to;
      }));
      return;
    }
    const start = Math.min(...due.map((w) => w.checked + 1), from);
    const blocks = Array.from({ length: to - start + 1 }, (_, i) => start + i);
    for (let i = 0; i < blocks.length; i += 100) {
      const updates = await this.#rpc.batch<StateUpdate[]>(
        blocks.slice(i, i + 100).map((n) => ({ method: "starknet_getStateUpdate", params: { block_id: { block_number: n } } })),
      );
      for (const [j, u] of updates.entries()) {
        const n = blocks[i + j]!;
        for (const r of u.state_diff.replaced_classes) {
          const w = this.byAddress.get(canonical(r.contract_address));
          if (w === undefined || n <= w.checked) continue;
          this.#log(`${w.contract} ${w.address}: class replaced at block ${n} (${r.class_hash})`);
          await this.#extend(w, [{ from: n, classHash: r.class_hash }]);
        }
      }
    }
    for (const w of due) w.checked = to;
  }
}

/** A factory: children are the `parameter` of its `event`. */
export type FactorySource = {
  contract: string;
  address: string;
  abi: Abi;
  event: string;
  parameter: string;
  startBlock: number;
};

/** Decodes a factory's creation events into children. */
export function factoryReader(f: FactorySource, spans: (ClassSpan & { abi: Abi })[]) {
  const decode = createHistoricalDecoder(spans);
  const selectors = new Set<string>();
  for (const s of spans) for (const e of abiEvents(s.abi)) if (e.name === f.event) selectors.add(e.selectors[0]!);
  if (selectors.size === 0) selectors.add(selector(f.event.split(".").at(-1)!));
  return {
    selectors: [...selectors],
    child(e: { block_number?: number; keys: string[]; data: string[] }): string | undefined {
      const decoded = decode(e.block_number!, e.keys, e.data);
      if (decoded === undefined || decoded.name !== f.event) return undefined;
      const value = (decoded.args as Record<string, unknown>)[f.parameter];
      if (typeof value !== "string") throw new Error(`${f.contract}: ${f.event}.${f.parameter} is not an address`);
      return canonical(value);
    },
  };
}
