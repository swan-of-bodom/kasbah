// A simulated Starknet node for benchmarks: `starknet_getEvents` answered from kasbah's event cache with hosted
// Pathfinder's limits (Alchemy's), after a fixed delay; any other call recorded from KASBAH_RPC_URL once, then
// replayed. Every run sees the same node, so a fetcher change is measured without the provider's moods.
// It answers its own chain id, `SN_BENCH`, so an app's event cache on it is a schema of its own, never mainnet's.
//   node --env-file=.env test/bench/node.ts --port 42170 --latency 120
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import pg from "pg";
import { feltHex, unpackHex } from "../../src/db/cache.ts";

const { values: a } = parseArgs({
  options: {
    port: { type: "string", default: "42170" },
    latency: { type: "string", default: "120" },
    schema: { type: "string", default: "kasbah_cache_0x534e5f4d41494e" },
  },
});

/** `SN_BENCH` as a felt: the chain id the simulated node answers. */
const BENCH_CHAIN = "0x534e5f42454e4348";

const MAX_CHUNK = 1_024;
const SCAN_LIMIT = 81_920;
const PAGE_SIZE_TOO_BIG = 31;
const METHOD_NOT_FOUND = -32601;
const latency = Number(a.latency);
const recordedPath = join(
  process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
  "kasbah-bench",
  "rpc-recorded.json",
);
const recorded: Record<string, { result?: unknown; error?: unknown }> = existsSync(recordedPath)
  ? JSON.parse(readFileSync(recordedPath, "utf8"))
  : {};
let forwarded = 0;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 16 });

/** Cached ranges per address and selector, `[from, to)`. */
const coverage = new Map<string, [number, number][]>();
for (const r of (
  await pool.query<{ address: string; selector: string; ranges: string }>(
    `SELECT encode(address, 'hex') AS address, encode(selector, 'hex') AS selector, ranges::text FROM ${a.schema}.coverage`,
  )
).rows)
  coverage.set(
    `${r.address}:${r.selector}`,
    [...r.ranges.matchAll(/\[(\d+),(\d+)\)/g)].map((m) => [Number(m[1]), Number(m[2])]),
  );
const covered = (address: string, selector: string, from: number, to: number) =>
  (coverage.get(`${address}:${selector}`) ?? []).some(([lo, hi]) => lo <= from && to < hi);

const felt = (h: string) =>
  h.length === 0 ? "0x0" : h.charCodeAt(0) === 48 ? `0x${h.slice(1)}` : `0x${h}`;

type Filter = {
  from_block: { block_number: number };
  to_block: { block_number: number };
  address?: string | string[];
  keys?: string[][];
  chunk_size: number;
  continuation_token?: string;
};

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

async function getEvents({ filter: f }: { filter: Filter }) {
  if (f.chunk_size > MAX_CHUNK)
    throw new RpcError(PAGE_SIZE_TOO_BIG, "Requested page size is too big");
  const to = f.to_block.block_number;
  let [start, skip] = [f.from_block.block_number, 0];
  if (f.continuation_token !== undefined)
    [start, skip] = f.continuation_token.split("-").map(Number) as [number, number];
  const end = Math.min(to, start + SCAN_LIMIT - 1);
  const addresses = (f.address === undefined ? [] : [f.address].flat()).map(feltHex);
  const selectors = (f.keys?.[0] ?? []).map(feltHex);
  const known = addresses.filter((x) => [...coverage.keys()].some((k) => k.startsWith(`${x}:`)));
  if (known.length > 0 && (selectors.length === 0 || (f.keys?.length ?? 0) > 1))
    throw new RpcError(-32602, "the simulated node serves a cached address by its selectors only");
  for (const x of known)
    for (const s of selectors)
      if (!covered(x, s, start, end))
        throw new RpcError(-32603, `blocks ${start}-${end} of ${x}:${s} are not in the cache`);
  if (known.length === 0)
    return end < to ? { events: [], continuation_token: `${end + 1}-0` } : { events: [] };
  const rows = (
    await pool.query<{
      block: number;
      tx: number;
      idx: number;
      address: string;
      block_hash: string;
      tx_hash: string;
      keys: string;
      data: string;
    }>(
      `SELECT block, tx, idx, encode(address, 'hex') AS address, encode(block_hash, 'hex') AS block_hash,
              encode(tx_hash, 'hex') AS tx_hash, encode(keys, 'hex') AS keys, encode(data, 'hex') AS data
       FROM ${a.schema}.events WHERE block BETWEEN $1 AND $2 AND address = ANY($3) AND selector = ANY($4)
       ORDER BY block, tx, idx LIMIT $5 OFFSET $6`,
      [
        start,
        end,
        known.map((x) => Buffer.from(x, "hex")),
        selectors.map((s) => Buffer.from(s, "hex")),
        f.chunk_size + 1,
        skip,
      ],
    )
  ).rows;
  const page = rows.slice(0, f.chunk_size);
  const events = page.map((r) => ({
    from_address: felt(r.address),
    keys: unpackHex(r.keys),
    data: unpackHex(r.data),
    block_hash: felt(r.block_hash),
    block_number: r.block,
    transaction_hash: felt(r.tx_hash),
    transaction_index: r.tx,
    event_index: r.idx,
  }));
  if (rows.length > f.chunk_size) {
    const next = rows[f.chunk_size]!.block;
    const before = page.filter((r) => r.block === next).length + (next === start ? skip : 0);
    return { events, continuation_token: `${next}-${before}` };
  }
  return end < to ? { events, continuation_token: `${end + 1}-0` } : { events };
}

async function replay(method: string, params: unknown) {
  const key = JSON.stringify([method, params]);
  let hit = recorded[key];
  if (hit === undefined) {
    const url = process.env.KASBAH_RPC_URL;
    if (url === undefined)
      throw new RpcError(-32603, `${method} is not recorded and KASBAH_RPC_URL is unset`);
    const res = (await (
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })
    ).json()) as { result?: unknown; error?: unknown };
    hit = res.error === undefined ? { result: res.result } : { error: res.error };
    recorded[key] = hit;
    forwarded++;
    mkdirSync(dirname(recordedPath), { recursive: true });
    writeFileSync(recordedPath, JSON.stringify(recorded));
  }
  if (hit.error !== undefined) {
    const e = hit.error as { code: number; message: string };
    throw new RpcError(e.code, e.message);
  }
  return hit.result;
}

type Call = { id: number; method: string; params: unknown };

async function answer(c: Call) {
  try {
    if (c.method === "starknet_getEvents")
      return { jsonrpc: "2.0", id: c.id, result: await getEvents(c.params as { filter: Filter }) };
    if (c.method === "starknet_chainId") return { jsonrpc: "2.0", id: c.id, result: BENCH_CHAIN };
    if (c.method === "pathfinder_version" || c.method === "juno_version")
      throw new RpcError(METHOD_NOT_FOUND, "Method not found");
    return { jsonrpc: "2.0", id: c.id, result: await replay(c.method, c.params) };
  } catch (e) {
    if (!(e instanceof RpcError)) throw e;
    return { jsonrpc: "2.0", id: c.id, error: { code: e.code, message: e.message } };
  }
}

const server = createServer(async (req, res) => {
  const arrived = performance.now();
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Call | Call[];
  const out = Array.isArray(body) ? await Promise.all(body.map(answer)) : await answer(body);
  const wait = latency - (performance.now() - arrived);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(out));
});

const stop = () => {
  console.error(`simulated node: ${forwarded} calls forwarded to the real RPC and recorded`);
  server.close();
  void pool.end();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
server.listen(Number(a.port), "127.0.0.1", () => console.log(`ready ${a.port}`));
