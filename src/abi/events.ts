import type { Abi, AbiEvent, AbiMember, Cairo1EventEnum, Cairo1EventStruct, EventMember } from "./abi.ts";
import { Codec, type Cursor, DecodeError, type Reader } from "./codec.ts";
import { felt } from "../types/felt.ts";
import { rawSelector } from "./selector.ts";
import type { DecodedEvent } from "./types.ts";

/** One concrete event a contract can emit, after resolving Cairo 1 enum nesting. */
export type EventDef = {
  /** Variant path joined by `.` for Cairo 1 (`"Swapped"`, `"OwnedEvent.OwnershipTransferred"`), the name for Cairo 0. */
  name: string;
  /** The selector keys that identify it: `keys` starts with these. */
  selectors: string[];
  /** Members read from `keys` after the selectors, in order. Filters by argument can use these. */
  keyMembers: AbiMember[];
  dataMembers: AbiMember[];
};

function lastSegment(name: string): string {
  const at = name.lastIndexOf("::");
  return at === -1 ? name : name.slice(at + 2);
}

/** Every event the ABI can emit, with its selector path. Throws if two events share the same selectors. */
export function abiEvents(abi: Abi): EventDef[] {
  const events = abi.filter((i): i is AbiEvent => i.type === "event");
  const byName = new Map(events.map((e) => [e.name, e]));
  const out: EventDef[] = [];

  const leaf = (struct: Cairo1EventStruct, name: string, selectors: string[]) => {
    const unsupported = struct.members.find((m) => m.kind === "nested" || m.kind === "flat");
    if (unsupported !== undefined) {
      throw new DecodeError(`${struct.name}: event member ${unsupported.name} of kind ${unsupported.kind} is not supported`);
    }
    out.push({
      name,
      selectors,
      keyMembers: struct.members.filter((m) => m.kind === "key"),
      dataMembers: struct.members.filter((m) => m.kind === "data"),
    });
  };

  const walk = (en: Cairo1EventEnum, path: string[], selectors: string[]) => {
    for (const v of en.variants) {
      const inner = byName.get(v.type);
      if (inner === undefined || !("kind" in inner)) throw new DecodeError(`${en.name}: unknown event type ${v.type}`);
      const flat = v.kind === "flat";
      const nextPath = flat ? path : [...path, v.name];
      const nextSelectors = flat ? selectors : [...selectors, rawSelector(v.name)];
      if (inner.kind === "enum") walk(inner, nextPath, nextSelectors);
      else if (flat) throw new DecodeError(`${en.name}: flat variant ${v.name} must wrap an enum`);
      else leaf(inner, nextPath.join("."), nextSelectors);
    }
  };

  const referenced = new Set<string>();
  for (const e of events) {
    if ("variants" in e) for (const v of e.variants as readonly EventMember[]) referenced.add(v.type);
  }

  for (const e of events) {
    if ("keys" in e && "data" in e) {
      out.push({ name: e.name, selectors: [rawSelector(e.name)], keyMembers: [...e.keys], dataMembers: [...e.data] });
    } else if ("inputs" in e) {
      const name = lastSegment(e.name);
      out.push({ name, selectors: [rawSelector(name)], keyMembers: [], dataMembers: [...e.inputs] });
    } else if (e.kind === "enum" && !referenced.has(e.name)) {
      walk(e, [], []);
    }
  }

  // Some Cairo 0 ABIs declare an event twice (JediSwap pairs: Transfer with `from_` and with `from_address`).
  // The same layout decodes the same felts: keep the first. A different layout is ambiguous.
  const layout = (e: EventDef) => `${e.keyMembers.map((m) => m.type).join(",")}|${e.dataMembers.map((m) => m.type).join(",")}`;
  const seen = new Map<string, EventDef>();
  const kept: EventDef[] = [];
  for (const e of out) {
    const id = e.selectors.join(",");
    const other = seen.get(id);
    if (other === undefined) {
      seen.set(id, e);
      kept.push(e);
    } else if (other.name !== e.name || layout(other) !== layout(e)) {
      throw new DecodeError(`events ${other.name} and ${e.name} have the same selectors`);
    }
  }
  return kept;
}

type Compiled = { name: string; depth: number; keys: Reader; data: Reader };
type Node = { event?: Compiled; children: Map<string, Node> };

/**
 * Builds a decoder for every event in the ABI. The returned function returns `undefined` for events the ABI doesn't
 * declare, and throws `DecodeError` when an event matches but its felts don't fit the ABI (wrong ABI or version).
 */
export function createDecoder<const TAbi extends Abi>(
  abi: TAbi,
): (keys: readonly string[], data: readonly string[]) => DecodedEvent<TAbi> | undefined {
  const codec = new Codec(abi);
  const root: Node = { children: new Map() };
  for (const def of abiEvents(abi)) {
    let node = root;
    for (const s of def.selectors) {
      let child = node.children.get(s);
      if (child === undefined) {
        child = { children: new Map() };
        // Keys as the node sends them or padded (`event.log`): both decode.
        node.children.set(s, child).set(felt(s), child);
      }
      node = child;
    }
    node.event = {
      name: def.name,
      depth: def.selectors.length,
      keys: codec.members(def.keyMembers),
      data: codec.members(def.dataMembers),
    };
  }

  return (keys, data) => {
    let node = root;
    let event: Compiled | undefined;
    for (const key of keys) {
      const child = node.children.get(key);
      if (child === undefined) break;
      node = child;
      if (node.event !== undefined) {
        event = node.event;
        break;
      }
    }
    if (event === undefined) return undefined;

    const k: Cursor = { felts: keys, i: event.depth };
    const d: Cursor = { felts: data, i: 0 };
    let args: Record<string, unknown>;
    try {
      args = { ...(event.keys(k) as object), ...(event.data(d) as object) };
    } catch (e) {
      throw new DecodeError(`${event.name}: ${(e as Error).message}`);
    }
    if (k.i !== keys.length || d.i !== data.length) {
      throw new DecodeError(
        `${event.name}: read ${k.i}/${keys.length} keys and ${d.i}/${data.length} data felts, the ABI doesn't match`,
      );
    }
    return { name: event.name, args } as DecodedEvent<TAbi>;
  };
}
