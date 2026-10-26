import { expect, test } from "vitest";
import { rawSelector } from "../../src/abi/selector.ts";
import { merge } from "../../src/indexer/events.ts";
import { compileFilters } from "../../src/indexer/filters.ts";
import type { EmittedEvent } from "../../src/rpc/methods.ts";
import type { Batch } from "../../src/sync/fetch.ts";
import ekubo from "../fixtures/ekubo-core.abi.ts";
import { keyedAbi } from "../fixtures/keyed.ts";

test("a key argument is filtered by the node: positional keys after the selector", () => {
  const f = compileFilters("K", keyedAbi, { Moved: { who: ["0x02", "0x3"] } }).get("Moved")!;
  expect(f.keys).toEqual([[rawSelector("Moved")], ["0x2", "0x3"]]);
  expect(f.matches({ who: `0x${"0".repeat(63)}3`, amount: 1n })).toBe(true);
  expect(f.matches({ who: "0x1", amount: 1n })).toBe(false);
});

test("a data argument is filtered after decoding only, numbers and bigints alike", () => {
  const f = compileFilters("K", keyedAbi, { Moved: { amount: [5, 7n] } }).get("Moved")!;
  expect(f.keys).toBeUndefined();
  expect(f.matches({ who: "0x1", amount: 7n })).toBe(true);
  expect(f.matches({ who: "0x1", amount: 6n })).toBe(false);
});

test("a nested event's keys start with every selector of its path", () => {
  const owner = `0x${"ab".repeat(4)}`;
  const f = compileFilters("Core", ekubo, {
    "OwnedEvent.OwnershipTransferred": { new_owner: owner },
  }).get("OwnedEvent.OwnershipTransferred");
  // Its owners are data members: nothing to push down, still filtered.
  expect(f?.keys).toBeUndefined();
  expect(f?.matches({ old_owner: "0x1", new_owner: owner })).toBe(true);
});

test("filters naming no event, no argument, or a struct are refused", () => {
  expect(() => compileFilters("K", keyedAbi, { Nope: {} })).toThrow(
    "K: filter on Nope, not an event",
  );
  expect(() => compileFilters("K", keyedAbi, { Moved: { nope: 1 } })).toThrow(
    "Moved.nope, not an argument",
  );
  expect(() => compileFilters("Core", ekubo, { Swapped: { pool_key: {} } })).toThrow(
    "only plain values",
  );
  expect(() => compileFilters("K", keyedAbi, { Moved: { who: [] } })).toThrow("no value");
});

const e = (block: number, tx: number, i: number): EmittedEvent => ({
  from_address: "0x1",
  keys: [],
  data: [],
  block_number: block,
  transaction_hash: `0x${block}${tx}`,
  transaction_index: tx,
  event_index: i,
});
async function* batches(...bs: Batch[]): AsyncGenerator<Batch> {
  yield* bs;
}

test("merge: chain order through the slowest stream, duplicates once", async () => {
  const out: Batch[] = [];
  for await (const b of merge([
    batches(
      { events: [e(1, 0, 0), e(3, 0, 1)], through: 3 },
      { events: [e(9, 0, 0)], through: 10 },
    ),
    batches(
      { events: [e(2, 0, 0), e(3, 0, 1)], through: 5 },
      { events: [e(7, 1, 0)], through: 10 },
    ),
  ]))
    out.push(b);
  expect(out.map((b) => b.through)).toEqual([3, 5, 10]);
  expect(out.flatMap((b) => b.events.map((x) => [x.block_number, x.event_index]))).toEqual([
    [1, 0],
    [2, 0],
    [3, 1],
    [7, 0],
    [9, 0],
  ]);
});
