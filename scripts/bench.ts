// Backfill benchmark. Example:
//   node --env-file=.env --no-warnings scripts/bench.ts --endpoint alchemy --from 900000 --to 1000000 --concurrency 32
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createDecoder } from "../src/abi/events.ts";
import { classHistory, createHistoricalDecoder } from "../src/abi/history.ts";
import type { Abi } from "../src/index.ts";
import { RpcClient } from "../src/rpc/client.ts";
import type { EmittedEvent } from "../src/rpc/methods.ts";
import { blockNumber, getEvents, getHeaders } from "../src/rpc/methods.ts";
import { probe } from "../src/rpc/probe.ts";
import { eventStream, type FetchStats } from "../src/sync/fetch.ts";
import { endpoints } from "./endpoints.ts";

const EKUBO_CORE = "0x00000005dd3d2f4429af886cd1a3b08289dbcea99a294197e9eb43b0e0325b4b";

const { values: a } = parseArgs({
  allowNegative: true,
  options: {
    endpoint: { type: "string", default: "alchemy" },
    from: { type: "string" },
    to: { type: "string" },
    concurrency: { type: "string", default: "32" },
    window: { type: "string" },
    sequential: { type: "boolean", default: false },
    decode: { type: "boolean", default: true },
    headers: { type: "string", default: "0" },
    "header-batch": { type: "string", default: "100" },
    "first-block": { type: "boolean", default: false },
    history: { type: "boolean", default: false },
  },
});

const url = endpoints()[a.endpoint!];
if (url === undefined) throw new Error(`unknown endpoint ${a.endpoint}`);
const concurrency = Number(a.concurrency);
const rpc = new RpcClient(url, { maxConcurrency: Math.max(concurrency, 8) });
const endpoint = await probe(rpc);
const head = await blockNumber(rpc);

if (a["first-block"]) {
  let token: string | undefined;
  for (;;) {
    const page = await getEvents(
      rpc,
      { from_block: { block_number: 0 }, to_block: { block_number: head }, address: EKUBO_CORE },
      1,
      token,
    );
    if (page.events.length > 0) {
      console.log("first Ekubo Core event at block", page.events[0]!.block_number);
      break;
    }
    token = page.continuation_token;
    if (token === undefined) throw new Error("no events");
  }
  process.exit(0);
}

const from = Number(a.from ?? head - 100_000);
const to = Number(a.to ?? head);
const todayDecode = createDecoder(
  JSON.parse(
    readFileSync(new URL("../test/fixtures/ekubo-core.abi.json", import.meta.url), "utf8"),
  ) as Abi,
);
let decode = (_block: number, keys: readonly string[], data: readonly string[]) =>
  todayDecode(keys, data);
if (a.history) {
  const spans = await classHistory(rpc, EKUBO_CORE, from, to);
  const withAbis = await Promise.all(
    spans.map(async (s) => {
      const cls = await rpc.request<{ abi: string | Abi }>("starknet_getClass", {
        block_id: "latest",
        class_hash: s.classHash,
      });
      return { ...s, abi: (typeof cls.abi === "string" ? JSON.parse(cls.abi) : cls.abi) as Abi };
    }),
  );
  decode = createHistoricalDecoder(withAbis);
  console.error(`decoding with ${spans.length} classes`);
}
let unknown = 0;

let checksum = 0n;
let decodeMs = 0;
let decodeErrors = 0;
const blocks = new Set<number>();
const counts: Record<string, number> = {};

/** Counts and decodes each page as it arrives: pages come out of chain order, and nothing here depends on it. */
function onEvents(events: EmittedEvent[]) {
  for (const e of events) {
    checksum +=
      (BigInt(e.block_number!) << 40n) +
      (BigInt(e.transaction_index) << 20n) +
      BigInt(e.event_index);
    blocks.add(e.block_number!);
  }
  if (!a.decode) return;
  const t = performance.now();
  for (const e of events) {
    try {
      const d = decode(e.block_number!, e.keys, e.data);
      if (d) counts[d.name] = (counts[d.name] ?? 0) + 1;
      else unknown++;
    } catch {
      decodeErrors++;
    }
  }
  decodeMs += performance.now() - t;
}

const t0 = performance.now();
const stats: FetchStats = { events: 0, pages: 0, windows: 0, splits: 0, narrowed: 0 };
const stream = eventStream(
  {
    rpc,
    address: EKUBO_CORE,
    from,
    to,
    chunkSize: endpoint.maxChunk,
    concurrency: a.sequential ? 1 : concurrency,
    windowEvents: a.window === undefined ? undefined : Number(a.window),
    minSplit: a.sequential ? Number.POSITIVE_INFINITY : 64,
    store: {
      write: async (events) => onEvents(events),
      room: async () => {},
      held: () => ({ bytes: 0, events: 0, max: 0 }),
    },
  },
  stats,
);
for await (const _ of stream);
const fetchMs = performance.now() - t0;

const result: Record<string, unknown> = {
  endpoint: `${a.endpoint} (${endpoint.node}, chunk ${endpoint.maxChunk})`,
  mode: a.sequential ? "sequential" : `parallel ×${concurrency}`,
  range: `${from}..${to} (${to - from + 1} blocks)`,
  events: stats.events,
  blocksWithEvents: blocks.size,
  pages: stats.pages,
  windows: stats.windows,
  splits: stats.splits,
  seconds: +(fetchMs / 1000).toFixed(2),
  eventsPerSecond: Math.round(stats.events / (fetchMs / 1000)),
  decodeMs: Math.round(decodeMs),
  decodePerEventUs: +((decodeMs * 1000) / Math.max(1, stats.events)).toFixed(2),
  decodeErrors,
  unknown,
  retries: rpc.stats.retries,
  throttled: rpc.stats.throttled,
  finalRate: rpc.rate,
  mbReceived: +(rpc.stats.bytes / 1e6).toFixed(1),
  checksum: checksum.toString(16),
};

const headerCount = Number(a.headers);
if (headerCount > 0) {
  const sample = [...blocks].slice(0, headerCount);
  const calls = rpc.stats.calls;
  const t = performance.now();
  await getHeaders(rpc, sample, Number(a["header-batch"]));
  const s = (performance.now() - t) / 1000;
  result.headers = `${sample.length} in ${s.toFixed(2)}s (${Math.round(sample.length / s)}/s, batch ${a["header-batch"]}, ${rpc.stats.calls - calls} calls)`;
}

console.log(JSON.stringify({ ...result, counts }, null, 1));
