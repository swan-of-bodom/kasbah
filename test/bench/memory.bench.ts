import { bench, describe } from "vitest";
import { frozenJson } from "../../src/db/table.ts";
import { approxBytes } from "../../src/utils/memory.ts";

/** An Ekubo `Swapped` row as the template stores it: three jsonb structs, bigints as strings. */
const row = (i: number) => ({
  id: `0x${(i * 7919).toString(16).padStart(63, "0")}:${i}`,
  block: 300_000 + i,
  transaction: `0x${(i * 104729).toString(16).padStart(63, "0")}`,
  locker: `0x${(i * 31).toString(16).padStart(63, "0")}`,
  pool_key: frozenJson({
    token0: `0x${"a".repeat(63)}`,
    token1: `0x${"b".repeat(63)}`,
    fee: 170141183460469231731687303715884105n,
    tick_spacing: 5982n,
    extension: "0x0",
  }),
  params: frozenJson({
    amount: { mag: 10n ** 18n + BigInt(i), sign: false },
    is_token1: true,
    sqrt_ratio_limit: 2n ** 190n,
    skip_ahead: 0n,
  }),
  delta: frozenJson({
    amount0: { mag: 123456789n * BigInt(i), sign: true },
    amount1: { mag: 987654321n, sign: false },
  }),
  sqrt_ratio_after: 2n ** 128n + BigInt(i),
  tick_after: { mag: 1234n, sign: true },
  liquidity_after: 10n ** 20n,
});
function before(value: unknown): number {
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
      let size = 24;
      for (const v of Array.isArray(value) ? value : Object.values(value)) size += before(v) + 8;
      return size;
    }
    default:
      return 8;
  }
}
const rows = Array.from({ length: 1000 }, (_, i) => row(i));

describe("approxBytes, 1,000 Swapped rows", () => {
  bench("Object.values (before)", () => {
    let n = 0;
    for (const r of rows) n += before(r);
    if (n === 0) throw new Error();
  });
  bench("approxBytes", () => {
    let n = 0;
    for (const r of rows) n += approxBytes(r);
    if (n === 0) throw new Error();
  });
});
