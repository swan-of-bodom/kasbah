import { createServer } from "node:http";
import { pgTable, text } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { bignum, kasbah } from "../../src/index.ts";
import { Status } from "../../src/indexer/status.ts";
import { counterAbi, counterNode } from "../fixtures/counter.ts";

const url = process.env.DATABASE_URL;
const schema = "kasbah_test_contracts";
const BLOCKS = 40;
const DEPLOYED = 13;
const totals = pgTable("totals", { id: text().primaryKey(), total: bignum().notNull() });
const node = counterNode(BLOCKS, { deployed: DEPLOYED });
const L1 = 20;
const settled = counterNode(BLOCKS, { l1: L1 });
/** Two addresses taking turns, behind a proxy recording each `getEvents` filter. */
const pair = counterNode(BLOCKS, { addresses: ["0xc", "0xe"] });
const asked: {
  address?: string[];
  from_block: { block_number: number };
  to_block: { block_number: number };
}[] = [];
const proxy = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    for (const c of [JSON.parse(body)].flat())
      if (c.method === "starknet_getEvents") asked.push(c.params.filter);
    const out = await (await fetch(pairUrl, { method: "POST", body })).text();
    res.writeHead(200, { "content-type": "application/json" }).end(out);
  });
});
let rpc: string;
let pairUrl: string;
let proxied: string;
let settledUrl: string;

const listen = async (s: ReturnType<typeof createServer>) => {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
};

beforeAll(async () => {
  [rpc, pairUrl, proxied, settledUrl] = (await Promise.all(
    [node, pair, proxy, settled].map(listen),
  )) as [string, string, string, string];
});
afterAll(async () => {
  for (const s of [node, pair, proxy, settled]) s.close();
  if (url === undefined) return;
  const p = new pg.Pool({ connectionString: url, max: 1 });
  await p.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await p.end();
});

const app = (
  c: { address: string | string[]; startBlock: number | "deployment"; endBlock?: number },
  at = rpc,
  l1 = false,
) => {
  const a = kasbah({
    cache: false,
    rpc: at,
    database: url,
    schema,
    contracts: { C: { abi: counterAbi, ...c } },
    tables: { totals },
    ...(l1 ? { finality: "l1" as const, pollMs: 20 } : { reorgWindow: 4 }),
    api: { port: 0 },
  });
  a.on("C:Counted", async ({ event, context }) => {
    const v = event.args.amount;
    await context.db
      .insert(totals)
      .values({ id: "all", total: v })
      .onConflictDoUpdate((r) => ({ total: r.total + v }));
  });
  return a;
};

test.skipIf(url === undefined)(
  'startBlock "deployment": indexes from the block it was deployed in',
  async () => {
    const status = new Status();
    const notes: string[] = [];
    status.subscribe((n) => notes.push(n.text));
    await app({ address: "0xc", startBlock: "deployment" }).run({
      reset: true,
      to: BLOCKS - 5,
      status,
    });
    expect(notes).toContain(`C was deployed in block ${DEPLOYED}: indexing from there`);
    const p = new pg.Pool({ connectionString: url, max: 1 });
    try {
      const r = await p.query(`SELECT total::text FROM ${schema}.totals`);
      // Block n counts n + 1: blocks DEPLOYED..35.
      let sum = 0;
      for (let n = DEPLOYED; n <= BLOCKS - 5; n++) sum += n + 1;
      expect(r.rows[0].total).toBe(String(sum));
    } finally {
      await p.end();
    }
  },
);

test.skipIf(url === undefined)(
  "address: [a, b] with endBlock: both indexed, nothing fetched after it",
  async () => {
    const END = 20;
    await app({ address: ["0xc", "0xe"], startBlock: 0, endBlock: END }, proxied).run({
      reset: true,
      to: BLOCKS - 5,
    });
    const p = new pg.Pool({ connectionString: url, max: 1 });
    try {
      const r = await p.query(`SELECT total::text FROM ${schema}.totals`);
      expect(r.rows[0].total).toBe(String(((END + 1) * (END + 2)) / 2));
    } finally {
      await p.end();
    }
    // The watched addresses' requests; the startup probe asks for one address, not a list.
    const fetched = asked.filter((f) => Array.isArray(f.address) && f.address.length > 0);
    expect(fetched.length).toBeGreaterThan(0);
    for (const f of fetched) {
      expect(f.to_block.block_number).toBeLessThanOrEqual(END);
      expect(f.address!.map(BigInt).sort()).toEqual([0xcn, 0xen]);
    }
  },
);

test.skipIf(url === undefined)(
  'finality "l1": blocks after the L1-accepted one keep their journal',
  async () => {
    const status = new Status();
    const stop = new AbortController();
    const run = app({ address: "0xc", startBlock: 0 }, settledUrl, true).run({
      reset: true,
      signal: stop.signal,
      status,
    });
    for (let i = 0; i < 500 && status.checkpoint !== BLOCKS - 1; i++)
      await new Promise((r) => setTimeout(r, 20));
    stop.abort();
    await run;
    expect(status.checkpoint).toBe(BLOCKS - 1);
    const p = new pg.Pool({ connectionString: url, max: 1 });
    try {
      const hashes = await p.query(`SELECT min(number)::int AS lo FROM ${schema}._kasbah_blocks`);
      expect(hashes.rows[0].lo).toBe(L1);
      const journal = await p.query(
        `SELECT min(block)::int AS lo, count(DISTINCT block)::int AS n FROM ${schema}._kasbah_journal`,
      );
      expect(journal.rows[0]).toEqual({ lo: L1 + 1, n: BLOCKS - 1 - L1 });
      const r = await p.query(`SELECT total::text FROM ${schema}.totals`);
      expect(r.rows[0].total).toBe(String((BLOCKS * (BLOCKS + 1)) / 2));
    } finally {
      await p.end();
    }
  },
);

test.skipIf(url === undefined)(
  "setup: seeds once, before the first event; a resumed run skips it",
  async () => {
    let ran = 0;
    const seeded = () => {
      const a = app({ address: "0xc", startBlock: 0 }, settledUrl);
      a.on("setup", async ({ context }) => {
        ran++;
        await context.db.insert(totals).values({ id: "all", total: 1000n });
      });
      return a;
    };
    await seeded().run({ reset: true, to: 10 });
    await seeded().run({ to: BLOCKS - 5 });
    expect(ran).toBe(1);
    const p = new pg.Pool({ connectionString: url, max: 1 });
    try {
      const r = await p.query(`SELECT total::text FROM ${schema}.totals`);
      expect(r.rows[0].total).toBe(String(1000 + ((BLOCKS - 4) * (BLOCKS - 3)) / 2));
    } finally {
      await p.end();
    }
  },
);

test.skipIf(url === undefined)(
  "/metrics: the indexer's while it runs, the stored checkpoint from serve",
  async () => {
    const status = new Status();
    const stop = new AbortController();
    const a = app({ address: "0xc", startBlock: 0 }, settledUrl);
    const run = a.run({ reset: true, signal: stop.signal, status });
    for (let i = 0; i < 500 && status.checkpoint !== BLOCKS - 1; i++)
      await new Promise((r) => setTimeout(r, 20));
    const live = await (await fetch(`${status.api}/metrics`)).text();
    stop.abort();
    await run;
    expect(live).toContain(`kasbah_checkpoint ${BLOCKS - 1}\n`);
    expect(live).toContain('kasbah_phase{phase="live"} 1');
    expect(live).toContain(`kasbah_handler_calls_total{handler="C:Counted"} ${BLOCKS}`);
    expect(live).toMatch(/kasbah_rpc_method_calls_total\{method="starknet_getEvents"\} \d+/);
    expect(live).toContain("# TYPE kasbah_events_handled_total counter");
    expect(live).toMatch(/kasbah_heap_used_bytes \d+/);
    expect(live).toMatch(/kasbah_heap_limit_bytes \d+/);
    expect(live).toMatch(/kasbah_gc_seconds_total [\d.e-]+/);
    expect(live).toMatch(/kasbah_event_loop_utilization [\d.e-]+/);

    const served = await a.serve();
    try {
      const stored = await (await fetch(`${served.url}/metrics`)).text();
      expect(stored).toContain(`kasbah_checkpoint ${BLOCKS - 1}\n`);
    } finally {
      await served.close();
    }
  },
);

test.skipIf(url === undefined)(
  "start blocks: a contract starting later isn't fetched before its start",
  async () => {
    asked.length = 0;
    const START = 20;
    const a = kasbah({
      cache: false,
      rpc: proxied,
      database: url,
      schema,
      contracts: {
        Early: { abi: counterAbi, address: "0xc", startBlock: 0 },
        Late: { abi: counterAbi, address: "0xe", startBlock: START },
      },
      tables: { totals },
      reorgWindow: 4,
    });
    for (const name of ["Early:Counted", "Late:Counted"] as const)
      a.on(name, async ({ event, context }) => {
        const v = event.args.amount;
        await context.db
          .insert(totals)
          .values({ id: event.contract, total: v })
          .onConflictDoUpdate((r) => ({ total: r.total + v }));
      });
    await a.run({ reset: true, to: BLOCKS - 5 });

    const p = new pg.Pool({ connectionString: url, max: 1 });
    try {
      const rows = (await p.query(`SELECT id, total::text FROM ${schema}.totals ORDER BY id`)).rows;
      // 0xc emits in even blocks, 0xe in odd ones; block n counts n + 1.
      let early = 0;
      let late = 0;
      for (let n = 0; n <= BLOCKS - 5; n++) {
        if (n % 2 === 0) early += n + 1;
        else if (n >= START) late += n + 1;
      }
      expect(rows).toEqual([
        { id: "Early", total: String(early) },
        { id: "Late", total: String(late) },
      ]);
    } finally {
      await p.end();
    }
    const withLate = asked.filter(
      (f) => Array.isArray(f.address) && f.address.some((x) => BigInt(x) === 0xen),
    );
    expect(withLate.length).toBeGreaterThan(0);
    for (const f of withLate) expect(f.from_block.block_number).toBeGreaterThanOrEqual(START);
    const before = asked.filter(
      (f) => Array.isArray(f.address) && f.from_block.block_number < START,
    );
    expect(before.length).toBeGreaterThan(0);
  },
);
