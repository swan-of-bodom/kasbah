import type { Server } from "node:http";
import { pgTable, text } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { bignum, kasbah } from "../../src/index.ts";
import { LOCK } from "../../src/indexer/lock.ts";
import { type Notice, Status } from "../../src/indexer/status.ts";
import { counterAbi, counterNode } from "../fixtures/counter.ts";

const url = process.env.DATABASE_URL;
const schema = "kasbah_test_lock";
const BLOCKS = 30;
const totals = pgTable("totals", { id: text().primaryKey(), total: bignum().notNull() });
const node: Server = counterNode(BLOCKS);
let rpc: string;
const saved = { ...LOCK };

beforeAll(async () => {
  await new Promise<void>((r) => node.listen(0, "127.0.0.1", r));
  rpc = `http://127.0.0.1:${(node.address() as { port: number }).port}`;
  LOCK.intervalMs = 100;
  LOCK.timeoutMs = 600;
});
afterEach(() => query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
afterAll(async () => {
  Object.assign(LOCK, saved);
  node.close();
});

async function query(sql: string, params: unknown[] = []) {
  if (url === undefined) return [];
  const p = new pg.Pool({ connectionString: url, max: 1 });
  try {
    return (await p.query(sql, params)).rows;
  } finally {
    await p.end();
  }
}

/** The counter app; `pause` holds the handler of that block until it resolves. */
function app(pause?: { block: number; until: Promise<void> }) {
  const a = kasbah({
    cache: false,
    rpc,
    database: url,
    schema,
    contracts: { C: { abi: counterAbi, address: "0xc", startBlock: 0 } },
    tables: { totals },
    reorgWindow: 4,
  });
  a.on("C:Counted", async ({ event, context }) => {
    if (event.block.number === pause?.block) await pause.until;
    const v = event.args.amount;
    await context.db
      .insert(totals)
      .values({ id: "all", total: v })
      .onConflictDoUpdate((r) => ({ total: r.total + v }));
  });
  return a;
}

/** A run that keeps following the head until `stop`, with its notices. */
function live(o: { dev?: boolean; pause?: { block: number; until: Promise<void> } } = {}) {
  const status = new Status();
  const notices: Notice[] = [];
  status.subscribe((n) => notices.push(n));
  const stop = new AbortController();
  const done = app(o.pause).run({
    signal: stop.signal,
    status,
    onBuildChange: o.dev ? "reset" : "error",
  });
  return { status, notices, stop: () => stop.abort(), done };
}

const until = async (c: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!c()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

test.skipIf(url === undefined)(
  "a second indexer on a held schema waits for the heartbeat once, then refuses",
  async () => {
    const first = live();
    await until(() => first.status.phase === "live");
    const second = live();
    await expect(second.done).rejects.toThrow(
      `schema "${schema}" is in use by another indexer: stop it, or use another --schema`,
    );
    expect(second.notices.some((n) => n.kind === "locked")).toBe(true);
    expect(first.status.phase).toBe("live");
    first.stop();
    await first.done;
  },
);

test.skipIf(url === undefined)(
  "a clean stop releases the lock: the next indexer starts at once",
  async () => {
    const first = live();
    await until(() => first.status.phase === "live");
    first.stop();
    await first.done;
    const next = live();
    await until(() => next.status.phase === "live");
    expect(next.notices.some((n) => n.kind === "locked")).toBe(false);
    next.stop();
    await next.done;
  },
);

test.skipIf(url === undefined)(
  "a crashed indexer's lock expires: the next one takes over and resumes",
  async () => {
    const first = live();
    await until(() => first.status.checkpoint === BLOCKS - 1);
    first.stop();
    await first.done;
    // As a crash leaves it: claimed, no heartbeat since.
    await query(
      `UPDATE ${schema}._kasbah_meta SET value = jsonb_build_object('owner', 'dead', 'heartbeat', $1::bigint, 'dev', false) WHERE key = 'lock'`,
      [Date.now() - 2 * LOCK.timeoutMs],
    );
    const next = live();
    await until(() => next.status.phase === "live");
    expect(next.notices.some((n) => n.kind === "locked")).toBe(false);
    next.stop();
    await next.done;
    const [row] = await query(`SELECT total::text FROM ${schema}.totals`);
    expect(row.total).toBe(String((BLOCKS * (BLOCKS + 1)) / 2));
  },
);

test.skipIf(url === undefined)(
  "an indexer whose lock was taken over writes nothing more",
  async () => {
    // A live block (the backfill stops 4 blocks behind the head), committed on its own.
    const LIVE = BLOCKS - 2;
    let resume!: () => void;
    const first = live({ pause: { block: LIVE, until: new Promise((r) => (resume = r)) } });
    await until(() => first.status.checkpoint === LIVE - 1);
    await query(
      `UPDATE ${schema}._kasbah_meta SET value = jsonb_set(value, '{owner}', '"other"') WHERE key = 'lock'`,
    );
    resume();
    await expect(first.done).rejects.toThrow(`lost the lock on schema "${schema}"`);
    const [{ value }] = await query(
      `SELECT value FROM ${schema}._kasbah_meta WHERE key = 'checkpoint'`,
    );
    expect(value).toBe(LIVE - 1);
  },
  20_000,
);

test.skipIf(url === undefined)(
  "dev refuses a schema start made; start drops one dev made",
  async () => {
    const started = live();
    await until(() => started.status.phase === "live");
    started.stop();
    await started.done;
    await expect(live({ dev: true }).done).rejects.toThrow(
      `schema "${schema}" holds what kasbah start indexed, and dev would drop it`,
    );

    await query(`DROP SCHEMA ${schema} CASCADE`);
    const dev = live({ dev: true });
    await until(() => dev.status.phase === "live");
    dev.stop();
    await dev.done;
    const next = live();
    await until(() => next.status.phase === "live");
    expect(next.notices.find((n) => n.kind === "rebuild")?.text).toMatch(
      /holds what kasbah dev indexed/,
    );
    next.stop();
    await next.done;
  },
);

test.skipIf(url === undefined)("clean refuses a schema a running indexer holds", async () => {
  const first = live();
  await until(() => first.status.phase === "live");
  await expect(app().drop()).rejects.toThrow(`schema "${schema}" is in use by a running indexer`);
  first.stop();
  await first.done;
  expect(await app().drop()).toBe(schema);
});
