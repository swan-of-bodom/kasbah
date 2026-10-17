import { transaction } from "../../db/transaction.ts";
import type { Run } from "../open.ts";

/** Primary keys and indexes, a transaction per table in parallel: each table is locked only while its own are built. */
export async function keys(run: Run): Promise<void> {
  const { status, store, tables, indexes, pool } = run;
  const started = performance.now();
  const count = [...indexes.values()].reduce((n, l) => n + l.length, 0);
  status.enter("keys");
  status.keys = { tables: store.unkeyed, indexes: count };
  const built = await Promise.all(tables.map((t) => transaction(pool, async (tx) => {
    const keyed = await store.addKey(t, tx);
    for (const statement of indexes.get(t)!) await tx.query(statement);
    return keyed;
  })));
  const seconds = (performance.now() - started) / 1000;
  const keys = built.filter(Boolean).length;
  if (keys > 0 || seconds >= 1) status.note({ kind: "keys", keys, indexes: count, seconds });
}
