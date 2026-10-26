import type { Abi } from "../abi/abi.ts";
import { abiEvents, createDecoder } from "../abi/events.ts";
import {
  type ClassSpan,
  classHistory,
  createHistoricalDecoder,
  type Decode,
} from "../abi/history.ts";
import { ConfigError } from "../config/errors.ts";
import type { RpcClient } from "../rpc/client.ts";
import { canonical } from "../types/felt.ts";
import { chunks } from "../utils/chunks.ts";
import type { CompiledFilter } from "./filters.ts";
import type { Note } from "./status.ts";

/** What `Sources` reports: class replacements and skipped ABI events. */
export type SourceNote = Extract<Note, { kind: "class" | "skipped" }>;

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
  /** Events announcing a class replacement (see `upgradeEventsOf`): undefined, none known. */
  upgrades: Set<string> | undefined;
  /** Filtered events by name; those with `keys` are fetched by their own stream, not the shared one. */
  filters: Map<string, CompiledFilter>;
};

/** A filtered event's own `getEvents` stream: its contract's addresses (changed in place) and its positional keys. */
export type Stream = { contract: string; event: string; addresses: string[]; keys: string[][] };

/** Upgrade events of the common upgradeable components (OpenZeppelin, Ekubo, StarkWare), found by name. */
const UPGRADE_EVENTS = ["Upgraded", "ClassHashReplaced", "ImplementationReplaced"];

/**
 * A contract's upgrade events: the configured ones (each must be in the ABI; `[]` for a contract that never
 * upgrades), else the common ones its ABI declares, else undefined.
 */
export function upgradeEventsOf(
  contract: string,
  abi: Abi,
  configured: readonly string[] | undefined,
): Set<string> | undefined {
  const names = abiEvents(abi).map((e) => e.name);
  if (configured !== undefined) {
    for (const n of configured)
      if (!names.includes(n))
        throw new ConfigError(`${contract}: upgradeEvents: the ABI has no event ${n}`);
    return new Set(configured);
  }
  const found = names.filter((n) => UPGRADE_EVENTS.some((u) => n === u || n.endsWith(`.${u}`)));
  return found.length > 0 ? new Set(found) : undefined;
}

/** Above this many addresses, live class checks read each block's state diff instead of asking per address. */
const PER_ADDRESS_CHECKS = 100;
/** `getStateUpdate` calls per batch request: diffs are large, so batches stay small. */
const STATE_UPDATES_PER_BATCH = 100;

type StateUpdate = {
  state_diff: { replaced_classes: { contract_address: string; class_hash: string }[] };
};

/**
 * Everything the fetcher watches: `addresses` and `keys` (shared with the fetchers, changed in place), each
 * address's class history and decoder.
 */
export class Sources {
  readonly addresses: string[] = [];
  /** `keys` filter: handled selectors at position 0. */
  readonly keys: string[][] = [[]];
  /** One per filtered event a key filter can fetch: merged with the shared stream in chain order. */
  readonly streams: Stream[] = [];
  readonly byAddress = new Map<string, Watched>();
  readonly #rpc: RpcClient;
  readonly #contracts = new Map<string, ContractSource>();
  readonly #abis = new Map<string, Promise<Abi>>();
  readonly #decoders = new WeakMap<Abi, Decode>();
  readonly #reported = new Set<string>();
  readonly #note: (n: SourceNote) => void;
  /** Per contract with upgrade events, their selectors. */
  readonly #upgradeSelectors = new Map<string, Set<string>>();
  #children = 0;

  /** Per contract, the configured ABI's decoder: for events the class at the address doesn't declare. */
  readonly #fallback = new Map<string, Decode>();

  constructor(rpc: RpcClient, contracts: ContractSource[], note: (n: SourceNote) => void) {
    this.#rpc = rpc;
    for (const c of contracts) {
      this.#contracts.set(c.name, c);
      for (const [event, f] of c.filters)
        if (f.keys !== undefined && c.handled.has(event))
          this.streams.push({ contract: c.name, event, addresses: [], keys: f.keys });
      this.#fallback.set(c.name, createDecoder(c.abi));
      if (c.upgrades !== undefined)
        this.#upgradeSelectors.set(
          c.name,
          new Set(
            abiEvents(c.abi)
              .filter((e) => c.upgrades!.has(e.name))
              .map((e) => e.selectors[0]!),
          ),
        );
      // Handled events of the configured ABI are always fetched, whatever the classes say (Cairo 0 proxies).
      this.#join(c, c.abi);
    }
    this.#note = note;
  }

  /** The filter on a contract's event, if any: events it doesn't match aren't handled. */
  filterOf(contract: string, event: string): CompiledFilter | undefined {
    return this.#contracts.get(contract)?.filters.get(event);
  }

  /** Factory children watched. */
  get children(): number {
    return this.#children;
  }

  /** Handled and upgrade events of `abi` join the `keys` filter, except those their own stream fetches. */
  #join(c: ContractSource, abi: Abi) {
    for (const e of abiEvents(abi)) {
      const own = c.filters.get(e.name)?.keys !== undefined && !c.upgrades?.has(e.name);
      if (
        (c.handled.has(e.name) || c.upgrades?.has(e.name)) &&
        !own &&
        !this.keys[0]!.includes(e.selectors[0]!)
      )
        this.keys[0]!.push(e.selectors[0]!);
    }
  }

  /**
   * Decodes with the class active at the block, and falls back to the configured ABI for an event that class
   * doesn't declare. A Cairo 0 proxy's class only has the proxy's own events: its implementation's come from
   * the configured ABI.
   */
  #decoder(contract: string, spans: (ClassSpan & { abi: Abi })[]) {
    const byClass = createHistoricalDecoder(spans, this.#decoderFor);
    const fallback = this.#fallback.get(contract)!;
    return (block: number, keys: readonly string[], data: readonly string[]) =>
      byClass(block, keys, data) ??
      (block < (spans[0]?.from ?? Infinity) ? undefined : fallback(keys, data));
  }

  abiOf(classHash: string): Promise<Abi> {
    let abi = this.#abis.get(classHash);
    if (abi === undefined) {
      abi = this.#rpc
        .request<{ abi: string | Abi }>("starknet_getClass", {
          block_id: "latest",
          class_hash: classHash,
        })
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

  /** Adds class spans to an address (a watched one's handled selectors join the filter); unknown event names are reported. */
  async #extend(w: Watched, spans: ClassSpan[]) {
    const c = this.#contracts.get(w.contract)!;
    const configured = new Set(abiEvents(c.abi).map((e) => e.name));
    for (const s of await this.#withAbis(spans)) {
      const missing = abiEvents(s.abi)
        .filter((e) => !configured.has(e.name))
        .map((e) => e.name);
      // Once per contract and event name: a contract upgraded 20 times reports the same event once.
      const unreported = missing.filter((m) => !this.#reported.has(`${c.name}:${m}`));
      if (unreported.length > 0) {
        for (const m of unreported) this.#reported.add(`${c.name}:${m}`);
        this.#note({
          kind: "skipped",
          contract: c.name,
          events: unreported,
          classHash: s.classHash,
        });
      }
      w.spans.push(s);
      if (this.byAddress.get(w.address) === w) this.#join(c, s.abi);
    }
    w.decode = this.#decoder(w.contract, w.spans);
  }

  /**
   * Reads the classes of `address` from block `from`, known up to `to`, without watching it yet (undefined: already
   * watched). Configured contracts get a full class history; children are probed at creation and at `to`, and
   * bisected only if those differ.
   */
  async resolve(
    contract: string,
    address: string,
    from: number,
    to: number,
    child: boolean,
  ): Promise<Watched | undefined> {
    const a = canonical(address);
    if (this.byAddress.has(a)) return undefined;
    const spans = await classHistory(
      this.#rpc,
      a,
      from,
      Math.max(from, to),
      child ? Number.MAX_SAFE_INTEGER : undefined,
    );
    if (spans.length === 0)
      throw new ConfigError(`${contract}: nothing deployed at ${a} by block ${to}`);
    const w: Watched = {
      contract,
      address: a,
      from,
      child,
      spans: [],
      decode: createHistoricalDecoder([]),
      checked: Math.max(from, to),
    };
    await this.#extend(w, spans);
    return w;
  }

  /** Starts watching a resolved address: it joins `addresses`, its handled selectors `keys`. False if already watched. */
  watch(w: Watched): boolean {
    if (this.byAddress.has(w.address)) return false;
    this.byAddress.set(w.address, w);
    this.addresses.push(w.address);
    for (const s of this.streams) if (s.contract === w.contract) s.addresses.push(w.address);
    if (w.child) this.#children++;
    const c = this.#contracts.get(w.contract)!;
    for (const s of w.spans) this.#join(c, s.abi);
    return true;
  }

  /** `resolve`, then `watch`. */
  async add(
    contract: string,
    address: string,
    from: number,
    to: number,
    child: boolean,
  ): Promise<Watched | undefined> {
    const w = await this.resolve(contract, address, from, to, child);
    return w !== undefined && this.watch(w) ? w : undefined;
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
    this.#children -= removed.length;
    if (removed.length > 0) {
      const gone = new Set(removed);
      for (const list of [this.addresses, ...this.streams.map((x) => x.addresses)])
        list.splice(0, list.length, ...list.filter((a) => !gone.has(a)));
    }
    return removed;
  }

  /**
   * Before a live block's events are handled: an address that emitted one of its upgrade events in it has its class
   * read at the block, and decodes the block with the new one.
   */
  async upgradesIn(
    events: readonly { from_address: string; keys: string[] }[],
    block: number,
  ): Promise<void> {
    const due = new Set<Watched>();
    for (const e of events) {
      const w = this.byAddress.get(canonical(e.from_address));
      if (w !== undefined && this.#upgradeSelectors.get(w.contract)?.has(e.keys[0]!)) due.add(w);
    }
    await Promise.all(
      [...due].map(async (w) => {
        const hash = await this.#rpc.request<string>("starknet_getClassHashAt", {
          block_id: { block_number: block },
          contract_address: w.address,
        });
        if (hash !== w.spans.at(-1)!.classHash) {
          this.#note({
            kind: "class",
            contract: w.contract,
            address: w.address,
            changes: [{ block, classHash: hash }],
          });
          await this.#extend(w, [{ from: block, classHash: hash }]);
        }
        w.checked = Math.max(w.checked, block);
      }),
    );
  }

  /**
   * Before live blocks `from..to` are indexed: finds class replacements among watched addresses whose contract has
   * no upgrade event (those are found by `upgradesIn`). Few addresses: one batched `getClassHashAt(to)`, bisecting
   * only a changed one. Many: each block's `replaced_classes`.
   */
  async checkClasses(from: number, to: number): Promise<void> {
    const due = [...this.byAddress.values()].filter(
      (w) => w.checked < to && this.#contracts.get(w.contract)!.upgrades === undefined,
    );
    if (due.length === 0) return;
    if (due.length <= PER_ADDRESS_CHECKS) {
      const current = await this.#rpc.batch<string[]>(
        due.map((w) => ({
          method: "starknet_getClassHashAt",
          params: { block_id: { block_number: to }, contract_address: w.address },
        })),
      );
      await Promise.all(
        due.map(async (w, i) => {
          if (current[i] !== w.spans.at(-1)!.classHash) {
            const changes = (
              await classHistory(this.#rpc, w.address, w.checked, to, Number.MAX_SAFE_INTEGER)
            ).slice(1);
            this.#note({
              kind: "class",
              contract: w.contract,
              address: w.address,
              changes: changes.map((s) => ({ block: s.from, classHash: s.classHash })),
            });
            await this.#extend(w, changes);
          }
          w.checked = to;
        }),
      );
      return;
    }
    const start = Math.min(...due.map((w) => w.checked + 1), from);
    const blocks = Array.from({ length: to - start + 1 }, (_, i) => start + i);
    for (const part of chunks(blocks, STATE_UPDATES_PER_BATCH)) {
      const updates = await this.#rpc.batch<StateUpdate[]>(
        part.map((n) => ({
          method: "starknet_getStateUpdate",
          params: { block_id: { block_number: n } },
        })),
      );
      for (const [j, u] of updates.entries()) {
        const n = part[j]!;
        for (const r of u.state_diff.replaced_classes) {
          const w = this.byAddress.get(canonical(r.contract_address));
          if (w === undefined || n <= w.checked) continue;
          this.#note({
            kind: "class",
            contract: w.contract,
            address: w.address,
            changes: [{ block: n, classHash: r.class_hash }],
          });
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
  const byClass = createHistoricalDecoder(spans);
  // A proxy factory's class doesn't declare the creation event: the configured ABI does.
  const fallback = createDecoder(f.abi);
  const decode = (block: number, keys: readonly string[], data: readonly string[]) =>
    byClass(block, keys, data) ?? fallback(keys, data);
  const selectors = new Set<string>();
  for (const abi of [...spans.map((s) => s.abi), f.abi])
    for (const e of abiEvents(abi)) if (e.name === f.event) selectors.add(e.selectors[0]!);
  if (selectors.size === 0)
    throw new ConfigError(`${f.contract}: the factory ABI has no event ${f.event}`);
  return {
    selectors: [...selectors],
    child(e: { block_number?: number; keys: string[]; data: string[] }): string | undefined {
      const decoded = decode(e.block_number!, e.keys, e.data);
      if (decoded === undefined || decoded.name !== f.event) return undefined;
      const value = (decoded.args as Record<string, unknown>)[f.parameter];
      // A ContractAddress decodes to hex, a Cairo 0 `felt` to a bigint.
      if (typeof value === "bigint") return `0x${value.toString(16)}`;
      if (typeof value !== "string")
        throw new ConfigError(`${f.contract}: ${f.event}.${f.parameter} is not an address`);
      return canonical(value);
    },
  };
}
