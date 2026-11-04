type ReplaceTuple<
  arr extends readonly unknown[],
  type,
  result extends readonly unknown[] = [],
> = arr extends [infer first, ...infer rest]
  ? ReplaceTuple<rest, type, readonly [...result, first extends bigint ? type : first]>
  : result;

/** `obj`'s type with every bigint in it as `type`. */
export type ReplaceBigInts<obj, type> = obj extends bigint
  ? type
  : obj extends unknown[]
    ? ReplaceTuple<Readonly<obj>, type>
    : obj extends readonly []
      ? ReplaceTuple<obj, type>
      : obj extends object
        ? { [key in keyof obj]: ReplaceBigInts<obj[key], type> }
        : obj;

/**
 * `obj` with every bigint in it (in arrays and plain objects, at any depth) replaced by `replacer(it)`: for JSON,
 * which has no bigints, e.g. `c.json(replaceBigInts(rows, String))`. Other objects (a `Date`, a `Buffer`) stay as
 * they are.
 */
export const replaceBigInts = <const T, const type>(
  obj: T,
  replacer: (x: bigint) => type,
): ReplaceBigInts<T, type> => {
  if (typeof obj === "bigint") return replacer(obj) as ReplaceBigInts<T, type>;
  if (Array.isArray(obj))
    return obj.map((x) => replaceBigInts(x, replacer)) as ReplaceBigInts<T, type>;
  if (isPlainObject(obj))
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, replaceBigInts(v, replacer)]),
    ) as ReplaceBigInts<T, type>;
  return obj as ReplaceBigInts<T, type>;
};

const isPlainObject = (x: unknown): x is Record<string, unknown> => {
  if (x === null || typeof x !== "object") return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
};
