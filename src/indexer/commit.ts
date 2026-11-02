import type pg from "pg";
import { liveChannel } from "../api/server.ts";
import type { EventCache } from "../db/cache.ts";
import type { Store } from "../db/store.ts";
import { transaction } from "../db/transaction.ts";
import type { BlockRef, LiveBlock } from "../sync/live.ts";
import type { SchemaLock } from "./lock.ts";
import type { Sources, Watched } from "./sources.ts";
import type { Status } from "./status.ts";

/** Every transaction that moves the run. Nothing else writes the app's tables or `_kasbah_*` after startup. */
export type Commit =
  /** Factory pre-pass: the children created through `through`, resolved and not yet watched. Not a checkpoint. */
  | { kind: "children"; through: number; children: Watched[] }
  /** Backfill: final blocks through `through`, no journal. */
  | { kind: "batch"; through: number }
  /** Entering live: the block it starts from. */
  | { kind: "follow"; head: BlockRef }
  /** Live: one block, with its undo journal, its hash, and the children created in it (already watched). */
  | { kind: "block"; block: LiveBlock; children: Watched[] }
  /** Undoes every block after `to`. */
  | { kind: "revert"; to: BlockRef }
  /** A run with an end (`to`): indexed through it, keys and indexes built. */
  | { kind: "done" };

/**
 * What a commit moves: the transaction writes these to `_kasbah_meta` (a moved checkpoint also notifies the API),
 * and after COMMIT memory takes the same values. `watermark`: factory children are known through this block.
 */
export type Moves = {
  checkpoint?: number;
  watermark?: number;
  phase?: "backfill" | "live" | "done";
};

export function moves(c: Commit, watermark: number): Moves {
  switch (c.kind) {
    case "children":
      return { watermark: Math.max(watermark, c.through), phase: "backfill" };
    case "batch":
      return { checkpoint: c.through, phase: "backfill" };
    case "follow":
      return { phase: "live" };
    case "block":
      return { checkpoint: c.block.number, watermark: c.block.number };
    case "revert":
      return c.to.number < watermark
        ? { checkpoint: c.to.number, watermark: c.to.number }
        : { checkpoint: c.to.number };
    case "done":
      return { phase: "done" };
  }
}

type Writers = {
  pool: pg.Pool;
  store: Store;
  cache: EventCache | undefined;
  factories: { contract: string }[];
  sources: Sources;
  status: Status;
  schema: string;
  lock: SchemaLock;
  final: () => number;
  start: number;
};

/**
 * The committed position, and the one way to move it. Phases hand nothing to each other but this: each starts from
 * it, so a phase with nothing left to do is a no-op.
 */
export class Position {
  readonly #w: Writers;
  #checkpoint: number | undefined;
  #watermark: number;
  readonly #known: Map<number, string>;
  /** The commit `start` began; it never rejects, its error waits in `#failed` for the next caller. */
  #writing: Promise<void> | undefined;
  #failed: { error: unknown } | undefined;

  constructor(
    w: Writers,
    stored: { checkpoint: number | undefined; watermark: number; known: Map<number, string> },
  ) {
    this.#w = w;
    this.#checkpoint = stored.checkpoint;
    this.#watermark = stored.watermark;
    this.#known = stored.known;
  }

  /** The last block committed (undefined: none yet). */
  get checkpoint(): number | undefined {
    return this.#checkpoint;
  }

  /** One for every factory: they always move together (a factory added later is another build). */
  get watermark(): number {
    return this.#watermark;
  }

  /** Hashes of indexed blocks inside the reorg window, by number (`follow` reads it by reference). */
  get known(): ReadonlyMap<number, string> {
    return this.#known;
  }

  /** The next block to index. */
  get next(): number {
    return Math.max(this.#w.start, (this.#checkpoint ?? -1) + 1);
  }

  /** Commits `c` once the commit `start` began is done, and waits for it. */
  async commit(c: Commit): Promise<{ undone: number; forgotten: number }> {
    await this.drain();
    const t = performance.now();
    try {
      return await this.#commit(c);
    } finally {
      this.#w.status.time.commit += performance.now() - t;
    }
  }

  /**
   * Starts `c` once the commit before it is done, and returns while Postgres writes it: the backfill handles the
   * next batch meanwhile. A failure is thrown by the next `start`, `commit` or `drain`.
   */
  async start(c: Commit): Promise<void> {
    await this.drain();
    this.#writing = this.#commit(c).then(
      () => {},
      (error: unknown) => {
        this.#failed = { error };
      },
    );
  }

  /** Waits for the commit `start` began; throws if it failed. The wait counts as time committing. */
  async drain(): Promise<void> {
    if (this.#writing !== undefined) {
      const t = performance.now();
      await this.#writing;
      this.#writing = undefined;
      this.#w.status.time.commit += performance.now() - t;
    }
    this.check();
  }

  /** Throws the error of a commit `start` began, without waiting for one still running. */
  check(): void {
    if (this.#failed !== undefined) throw this.#failed.error;
  }

  /**
   * A transaction per `Commit`, then, after COMMIT, memory follows (the position, the watched children, known
   * hashes) and `status.committed`. Store and cache hand over their buffers before the first await, so what's
   * handled meanwhile is the next commit's; a failed commit fails the run, so nothing retries against them.
   */
  async #commit(c: Commit): Promise<{ undone: number; forgotten: number }> {
    const { pool, store, cache, factories, sources, status, schema, lock, final } = this.#w;
    const m = moves(c, this.#watermark);
    const parts = { tables: 0, cache: 0 };
    const timed = async (part: keyof typeof parts, write: () => unknown) => {
      const t = performance.now();
      await write();
      parts[part] += performance.now() - t;
    };
    let undone = 0;
    const started = performance.now();
    const rows = c.kind === "batch" || c.kind === "block";
    if (rows) store.take();
    if (c.kind === "children" || c.kind === "batch") cache?.take(c.through);
    else if (c.kind === "block") cache?.take(-1);
    try {
      await transaction(pool, async (tx) => {
        await lock.check(tx);
        switch (c.kind) {
          case "children":
            await timed("cache", () => cache?.persist(tx));
            await insertChildren(tx, c.children);
            break;
          case "batch":
            await timed("tables", () => store.flush(tx));
            await timed("cache", () => cache?.persist(tx));
            break;
          case "follow":
            await saveHash(tx, c.head);
            break;
          case "block": {
            const n = c.block.number;
            await timed("tables", () => store.flush(tx, n));
            await timed("cache", () => cache?.persist(tx));
            await insertChildren(tx, c.children);
            await saveHash(tx, c.block);
            await tx.query(`DELETE FROM _kasbah_blocks WHERE number < $1`, [final()]);
            await tx.query(`DELETE FROM _kasbah_journal WHERE block < $1`, [final()]);
            break;
          }
          case "revert":
            await timed("tables", async () => (undone = await store.revert(tx, c.to.number)));
            await tx.query(`DELETE FROM _kasbah_blocks WHERE number > $1`, [c.to.number]);
            await tx.query(`DELETE FROM _kasbah_children WHERE block > $1`, [c.to.number]);
            break;
        }
        if (m.watermark !== undefined)
          for (const f of factories) await setMeta(tx, `discovered:${f.contract}`, m.watermark);
        if (m.phase !== undefined) await setMeta(tx, "phase", m.phase);
        if (m.checkpoint !== undefined) {
          await setMeta(tx, "checkpoint", m.checkpoint);
          // Delivered at COMMIT: API servers re-run live queries.
          await tx.query(`SELECT pg_notify($1, $2)`, [
            liveChannel(schema),
            JSON.stringify({ checkpoint: m.checkpoint }),
          ]);
        }
      });
    } finally {
      if (rows) store.written();
    }
    const ms = performance.now() - started;
    if (m.checkpoint !== undefined) this.#checkpoint = m.checkpoint;
    if (m.watermark !== undefined) this.#watermark = m.watermark;
    let forgotten = 0;
    switch (c.kind) {
      case "children":
        for (const w of c.children) sources.watch(w);
        break;
      case "follow":
        this.#known.set(c.head.number, c.head.hash);
        break;
      case "block":
        this.#known.set(c.block.number, c.block.hash);
        for (const n of this.#known.keys()) if (n < final()) this.#known.delete(n);
        break;
      case "revert":
        forgotten = sources.removeChildrenAfter(c.to.number).length;
        for (const n of this.#known.keys()) if (n > c.to.number) this.#known.delete(n);
        break;
    }
    const block =
      c.kind === "block"
        ? {
            number: c.block.number,
            timestamp: c.block.header.timestamp,
            events: c.block.events.length,
            children: c.children.length,
          }
        : undefined;
    status.committed({ kind: c.kind, ms, ...parts, checkpoint: this.#checkpoint, block });
    return { undone, forgotten };
  }
}

const setMeta = (tx: pg.PoolClient, key: string, value: unknown) =>
  tx.query(
    `INSERT INTO _kasbah_meta VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)],
  );

const saveHash = (tx: pg.PoolClient, block: BlockRef) =>
  tx.query(
    `INSERT INTO _kasbah_blocks VALUES ($1, $2) ON CONFLICT (number) DO UPDATE SET hash = EXCLUDED.hash`,
    [block.number, block.hash],
  );

const insertChildren = async (tx: pg.PoolClient, children: Watched[]) => {
  for (const w of children)
    await tx.query(`INSERT INTO _kasbah_children VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [
      w.address,
      w.contract,
      w.from,
    ]);
};
