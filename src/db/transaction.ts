import type pg from "pg";
import { Stopped } from "../utils/errors.ts";
import { sleep } from "../utils/sleep.ts";
import { queryOnce, retryOf } from "./pool.ts";
import { CommitUnknown, DB_RETRY, lostConnection, type Retry, retrying } from "./retry.ts";

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

/** Ends the backend that holds transaction `$1` (a 64-bit txid; `backend_xid` is its low 32 bits). */
const END_HOLDER = `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
  WHERE backend_xid::text = ($1::bigint % 4294967296)::text`;

/**
 * Whether transaction `xid`, whose COMMIT lost its connection, committed: Postgres keeps a recent transaction's
 * outcome (`txid_status`). One still in progress belongs to a backend that hasn't seen its client go (a network drop
 * that never reached the server, a slow COMMIT): that backend is ended, which settles it. If Postgres can't answer,
 * the run ends rather than guess.
 */
async function outcome(
  pool: pg.Pool,
  xid: string,
  retry: Partial<Retry>,
): Promise<"committed" | "aborted"> {
  const { tries, firstWaitMs } = { ...DB_RETRY, ...retry };
  const ask = <R extends pg.QueryResultRow>(text: string) =>
    retrying(() => queryOnce<R>(pool, text, [xid]), retry);
  try {
    for (let i = 0; i < tries; i++) {
      let status: string | null;
      try {
        status = (await ask<{ s: string | null }>("SELECT txid_status($1) AS s")).rows[0]!.s;
      } catch (e) {
        // A crash before any of it reached the disk: after the restart Postgres doesn't know the id at all.
        if (/in the future/.test(String((e as Error).message))) return "aborted";
        throw e;
      }
      if (status === "committed" || status === "aborted") return status;
      if (status === null) throw new Error("Postgres no longer keeps its outcome");
      await ask(END_HOLDER);
      await sleep(firstWaitMs * 2 ** i, retry.signal);
    }
    throw new Error(`still in progress after ${tries} checks`);
  } catch (e) {
    if (e instanceof Stopped || retry.signal?.aborted) throw e;
    throw new CommitUnknown(
      `transaction ${xid} lost its connection during COMMIT, and whether it committed is unknown`,
      { cause: e },
    );
  }
}
