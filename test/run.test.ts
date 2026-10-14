import { expect, test } from "vitest";
import type { Config } from "../src/app.ts";
import { moves, planOf } from "../src/run.ts";
import { upgradeEventsOf } from "../src/sources.ts";
import cairo0Pair from "./fixtures/cairo0-0.abi.ts";
import ekubo from "./fixtures/ekubo-core.abi.ts";
import strk from "./fixtures/strk.abi.ts";
import { type Notice, Status } from "../src/status.ts";
import { blockOf } from "../src/block.ts";
import { header } from "./fixtures/header.ts";

const config = (reorgWindow?: number): Config => ({
  rpc: "",
  database: "",
  contracts: { C: { abi: [], address: "0x1", startBlock: 10 } },
  blocks: { B: { interval: 5, startBlock: 7 } },
  tables: {},
  reorgWindow,
});

test("planOf: live backfills to the reorg window and reads classes to the tip; a `to` inside the window stops at its edge", () => {
  expect(planOf(config(4), undefined, 39)).toEqual({ live: true, window: 4, backfillTo: 35, classTo: 39, start: 7, clamped: false });
  expect(planOf(config(4), 39, 39)).toEqual({ live: false, window: 4, backfillTo: 35, classTo: 35, start: 7, clamped: true });
  expect(planOf(config(4), 20, 39)).toMatchObject({ backfillTo: 20, classTo: 20, clamped: false });
  expect(planOf(config(), undefined, 1000)).toMatchObject({ window: 64, backfillTo: 936 });
});

test("moves: what each commit writes to the meta table and then to memory", () => {
  const block = { number: 120, hash: "0xb", parent: "0xa", header: blockOf(header({ block_hash: "0xb", parent_hash: "0xa", block_number: 120, timestamp: 1 })), events: [] };
  expect(moves({ kind: "children", through: 90, children: [] }, 50)).toEqual({ watermark: 90, phase: "backfill" });
  expect(moves({ kind: "batch", through: 90 }, 90)).toEqual({ checkpoint: 90, phase: "backfill" });
  expect(moves({ kind: "follow", head: { number: 90, hash: "0x9" } }, 90)).toEqual({ phase: "live" });
  expect(moves({ kind: "block", block, children: [] }, 119)).toEqual({ checkpoint: 120, watermark: 120 });
  expect(moves({ kind: "revert", to: { number: 100, hash: "0x1" } }, 120)).toEqual({ checkpoint: 100, watermark: 100 });
  // A revert below the checkpoint but above a watermark that's behind it leaves the watermark.
  expect(moves({ kind: "revert", to: { number: 100, hash: "0x1" } }, 90)).toEqual({ checkpoint: 100 });
});

test("Status: commits move the gauges and note progress when due; a throwing listener doesn't stop the others", () => {
  const status = new Status();
  const notices: Notice[] = [];
  status.subscribe(() => {
    throw new Error("broken printer");
  });
  status.subscribe((n) => notices.push(n));
  const error = console.error;
  console.error = () => {};
  try {
    status.enter("live");
    const now = Date.now() / 1000;
    status.committed({ kind: "block", ms: 3, tables: 1, cache: 0, checkpoint: 7, block: { number: 7, timestamp: now, events: 0, children: 0 } });
    status.committed({ kind: "block", ms: 3, tables: 1, cache: 0, checkpoint: 8, block: { number: 8, timestamp: now, events: 2, children: 1 } });
    status.committed({ kind: "revert", ms: 2, tables: 0, cache: 0, checkpoint: 5 });
  } finally {
    console.error = error;
  }
  expect([status.checkpoint, status.live.block, status.live.reorgs, status.time.commit]).toEqual([5, 8, 1, 8]);
  // An empty live block is no line.
  expect(notices.map((n) => n.text)).toEqual([expect.stringMatching(/^block 8: 2 events, 1 new children, \d+\.\ds after its timestamp$/)]);
  status.fail(new Error("boom"));
  expect([status.phase, status.error]).toEqual(["failed", "boom"]);
});

test("upgrade events: the common ones by name, the configured ones checked, none for a contract without", () => {
  expect(upgradeEventsOf("Core", ekubo, undefined)).toEqual(new Set(["ClassHashReplaced"]));
  expect([...upgradeEventsOf("STRK", strk, undefined)!].every((n) => n.endsWith("ImplementationReplaced"))).toBe(true);
  // A Cairo 0 pair: no upgrade event, so its class is checked at every poll.
  expect(upgradeEventsOf("Pair", cairo0Pair, undefined)).toBeUndefined();
  expect(upgradeEventsOf("Core", ekubo, [])).toEqual(new Set());
  expect(() => upgradeEventsOf("Core", ekubo, ["Upgraded"])).toThrow("Core: upgradeEvents: the ABI has no event Upgraded");
});
