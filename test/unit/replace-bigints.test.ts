import { expect, test } from "vitest";
import { replaceBigInts } from "../../src/utils/replace-bigints.ts";

test("bigints in arrays and plain objects become the replacer's value; dates and buffers stay as they are", () => {
  const time = new Date("2024-01-02T03:04:05Z");
  const bytes = Buffer.from([1, 2]);
  const out = replaceBigInts(
    {
      a: 1n,
      list: [2n, { b: 3n }],
      time,
      bytes,
      none: null,
      bare: Object.assign(Object.create(null), { c: 4n }),
    },
    String,
  );
  expect(out).toEqual({
    a: "1",
    list: ["2", { b: "3" }],
    time,
    bytes,
    none: null,
    bare: { c: "4" },
  });
  expect(out.time).toBe(time);
  expect(JSON.parse(JSON.stringify(out)).time).toBe("2024-01-02T03:04:05.000Z");
});
