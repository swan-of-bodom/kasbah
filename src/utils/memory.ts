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
      for (const v of Array.isArray(value) ? value : Object.values(value))
        size += approxBytes(v) + 8;
      return size;
    }
    default:
      return 8;
  }
}
