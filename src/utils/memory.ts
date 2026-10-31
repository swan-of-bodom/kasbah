import { getHeapStatistics } from "node:v8";

export const heapLimit = (): number => getHeapStatistics().heap_size_limit;

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
      else for (const k in value) size += approxBytes((value as Record<string, unknown>)[k]) + 8;
      return size;
    }
    default:
      return 8;
  }
}
