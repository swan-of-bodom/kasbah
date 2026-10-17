import type pg from "pg";

/** `body` in BEGIN … COMMIT on one pooled connection; ROLLBACK on any error. */
export async function transaction<T>(pool: pg.Pool, body: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const tx = await pool.connect();
  let out: T;
  try {
    await tx.query("BEGIN");
    out = await body(tx);
    await tx.query("COMMIT");
  } catch (err) {
    // A failed ROLLBACK leaves the connection unusable: dropped, and the original error kept.
    await tx.query("ROLLBACK").then(() => tx.release(), (e) => tx.release(e));
    throw err;
  }
  tx.release();
  return out;
}
