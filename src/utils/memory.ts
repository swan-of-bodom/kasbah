import { getHeapStatistics } from "node:v8";

/** The heap this process may use: what the machine's memory, or `--max-old-space-size`, gives Node. */
export const heapLimit = (): number => getHeapStatistics().heap_size_limit;

/** A value's size in memory, roughly and on the high side, as Ponder's indexing cache estimates its rows. */
export function approxBytes(value: unknown): number {
  switch (typeof value) {
    case "string":
      return 2 * value.length;
    case "number":
      return 8;
    case "boolean":
      return 4;
    case "bigint":
      return 48;
    case "object": {
      if (value === null) return 8;
      if (ArrayBuffer.isView(value)) return 24 + value.byteLength;
      let size = 24;
      if (Array.isArray(value))
        for (let i = 0; i < value.length; i++) size += approxBytes(value[i]) + 8;
      // `for in` over own keys, not `Object.values`: no array allocated per object measured.
      else for (const k in value) size += approxBytes((value as Record<string, unknown>)[k]) + 8;
      return size;
    }
    default:
      return 8;
  }
}
