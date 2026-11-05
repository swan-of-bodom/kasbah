import type { Abi, AbiFunction } from "./abi.ts";
import { Codec, DecodeError, type Reader } from "./codec.ts";
import { rawSelector } from "./selector.ts";

/** Every function of an ABI: top-level (Cairo 0, Cairo 1 before 2.0) and inside interfaces. */
function abiFunctions(abi: Abi): AbiFunction[] {
  return abi.flatMap((i) =>
    i.type === "function"
      ? [i]
      : i.type === "interface"
        ? i.items.filter((f) => f.type === "function")
        : [],
  );
}

export type CompiledFunction = {
  name: string;
  selector: string;
  encode: (args: unknown) => string[];
  decode: (felts: readonly string[]) => unknown;
};

const compiled = new WeakMap<Abi, Map<string, CompiledFunction>>();

/**
 * Calldata encoder and result decoder for one function. Arguments are an object keyed by input name. The result:
 * Cairo 0 (named outputs) an object, Cairo 1 the single output's value, or a tuple when there are several.
 */
export function compileFunction(abi: Abi, name: string): CompiledFunction {
  let byName = compiled.get(abi);
  if (byName === undefined) compiled.set(abi, (byName = new Map()));
  const hit = byName.get(name);
  if (hit !== undefined) return hit;

  const f = abiFunctions(abi).find((x) => x.name === name);
  if (f === undefined) throw new TypeError(`no function ${name} in the ABI`);
  const codec = new Codec(abi);
  const write = codec.membersWriter(f.inputs);
  let read: Reader;
  if (f.outputs.length > 0 && f.outputs.every((o) => o.name !== undefined))
    read = codec.members(f.outputs as { name: string; type: string }[]);
  else if (f.outputs.length === 1) read = codec.reader(f.outputs[0]!.type);
  else {
    const items = f.outputs.map((o) => codec.reader(o.type));
    read = (c) => (items.length === 0 ? undefined : items.map((r) => r(c)));
  }
  const fn: CompiledFunction = {
    name,
    selector: rawSelector(name),
    encode: (args) => {
      const out: string[] = [];
      write(args ?? {}, out);
      return out;
    },
    decode: (felts) => {
      const c = { felts, i: 0 };
      const value = read(c);
      if (c.i !== felts.length)
        throw new DecodeError(`${name}: ${felts.length - c.i} result felts left over`);
      return value;
    },
  };
  byName.set(name, fn);
  return fn;
}
