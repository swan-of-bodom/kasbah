import type pg from "pg";
import { sleep } from "../utils/sleep.ts";
import { retryOf } from "./pool.ts";
import { DB_RETRY, lostConnection, type Retry, retrying } from "./retry.ts";

/**
 * `body` in BEGIN … COMMIT on one pooled connection; ROLLBACK on any error. A lost connection runs the whole
 * transaction again (`body` gets the attempt, from 0), so `body` leaves memory as it found it until COMMIT. A COMMIT
 * whose answer was lost is settled by asking Postgres whether the transaction committed, never by guessing.
 */
export async function transaction<T>(
  pool: pg.Pool,
  body: (tx: pg.PoolClient, attempt: number) => Promise<T>,
): Promise<T> {
  const retry = retryOf(pool);
  return retrying(async (attempt) => {
    const tx = await pool.connect();
    // pg-pool listens on idle connections only: one that dies mid-transaction would otherwise throw out of the
    // process. Its next query fails with "not queryable", which is retried.
    const ignore = () => {};
    tx.on("error", ignore);
    let xid: string | undefined;
    let committing = false;
    let out!: T;
    try {
      await tx.query("BEGIN");
      xid = (await tx.query<{ id: string }>("SELECT txid_current()::text AS id")).rows[0]!.id;
      out = await body(tx, attempt);
      committing = true;
      await tx.query("COMMIT");
    } catch (err) {
      if (lostConnection(err)) {
        tx.removeListener("error", ignore);
        tx.release(err as Error);
        if (committing && xid !== undefined && (await outcome(pool, xid, retry)) === "committed")
          return out;
        throw err;
      }
      // A failed ROLLBACK leaves the connection unusable: dropped, and the original error kept.
      await tx.query("ROLLBACK").then(
        () => tx.release(),
        (e) => tx.release(e),
      );
      tx.removeListener("error", ignore);
      throw err;
    }
    tx.removeListener("error", ignore);
    tx.release();
    return out;
  }, retry);
}

/**
 * Whether transaction `xid`, whose COMMIT lost its connection, committed: Postgres keeps a recent transaction's
 * outcome (`txid_status`). "in progress" means its backend hasn't ended it yet; asked again after a wait.
 */
async function outcome(
  pool: pg.Pool,
  xid: string,
  retry: Partial<Retry>,
): Promise<"committed" | "aborted"> {
  const { tries, firstWaitMs } = { ...DB_RETRY, ...retry };
  for (let i = 0; i < tries; i++) {
    const status = await retrying(async () => {
      try {
        return (await pool.query<{ s: string | null }>("SELECT txid_status($1) AS s", [xid]))
          .rows[0]!.s;
      } catch (e) {
        // A crash before any of it reached the disk: after the restart Postgres doesn't know the id at all.
        if (/in the future/.test(String((e as Error).message))) return "aborted";
        throw e;
      }
    }, retry);
    if (status === "committed") return "committed";
    if (status === "aborted") return "aborted";
    if (status === null)
      throw new Error(`Postgres no longer knows whether transaction ${xid} committed`);
    await sleep(firstWaitMs, retry.signal);
  }
  throw new Error(
    `transaction ${xid} lost its connection during COMMIT and was still in progress after ${tries} checks`,
  );
}
