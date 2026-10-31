import { expect, test } from "vitest";
import { canonical } from "../../src/types/felt.ts";
import { chunks } from "../../src/utils/chunks.ts";
import { errorCode } from "../../src/utils/errors.ts";
import { approxBytes } from "../../src/utils/memory.ts";
import { sleep } from "../../src/utils/sleep.ts";

test("chunks: consecutive slices, the last one shorter, none for nothing", () => {
  expect([...chunks([1, 2, 3, 4, 5], 2)]).toEqual([[1, 2], [3, 4], [5]]);
  expect([...chunks([], 3)]).toEqual([]);
});

test("sleep: an abort ends it at once, and an aborted signal doesn't wait at all", async () => {
  const stop = new AbortController();
  const started = performance.now();
  const slept = sleep(10_000, stop.signal);
  stop.abort();
  await slept;
  await sleep(10_000, stop.signal);
  expect(performance.now() - started).toBeLessThan(1_000);
});

test("errorCode: a string code, or nothing", () => {
  expect(errorCode(Object.assign(new Error("x"), { code: "23505" }))).toBe("23505");
  expect(errorCode(Object.assign(new Error("x"), { code: 24 }))).toBeUndefined();
  expect(errorCode(undefined)).toBeUndefined();
});

test("canonical: one form whatever the padding or case", () => {
  expect(canonical("0x00000005DD3D")).toBe("0x5dd3d");
  expect(canonical("0x0")).toBe("0x0");
});

test("approxBytes: strings by length, numbers, bigints and nesting, as Ponder's estimate", () => {
  expect(approxBytes("abcd")).toBe(8);
  expect(approxBytes({ a: 1, b: [1n, "xy"], c: null, d: true })).toBe(
    24 + (8 + 8) + (24 + (48 + 8) + (4 + 8) + 8) + (8 + 8) + (4 + 8),
  );
  expect(approxBytes(new Uint8Array(10))).toBe(34);
});
