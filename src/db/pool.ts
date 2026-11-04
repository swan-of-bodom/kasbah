import pg from "pg";
import { type Retry, retrying } from "./retry.ts";

/**
 * A `pg.Pool` that outlives a lost connection. A single statement sent with `query` is sent again after one, so every
 * statement kasbah sends this way must be a read or an idempotent write (`IF NOT EXISTS`, `ON CONFLICT`, a heartbeat);
 * work that must happen together goes through `transaction`, which retries the whole of it.
 */
export class RetryingPool extends pg.Pool {
  readonly retry: Partial<Retry>;

  constructor(config: pg.PoolConfig, retry: Partial<Retry> = {}) {
    super(config);
    this.retry = retry;
    // An idle connection that dies is already dropped from the pool, and the next query opens another. Without a
    // listener, Node would throw the pool's `error` event and end the process.
    this.on("error", () => {});
    const plain = pg.Pool.prototype.query.bind(this) as (...args: unknown[]) => unknown;
    this.query = ((...args: unknown[]) => {
      const callback = typeof args.at(-1) === "function";
      const submittable =
        typeof (args[0] as { submit?: unknown } | undefined)?.submit === "function";
      if (callback || submittable) return plain(...args);
      return retrying(() => plain(...args) as Promise<unknown>, this.retry);
    }) as pg.Pool["query"];
  }
}

/** One statement sent once, even on a `RetryingPool`: for callers that retry it themselves. */
export const queryOnce = <R extends pg.QueryResultRow>(
  pool: pg.Pool,
  text: string,
  values: unknown[],
): Promise<pg.QueryResult<R>> =>
  (pg.Pool.prototype.query as (t: string, v: unknown[]) => Promise<pg.QueryResult<R>>).call(
    pool,
    text,
    values,
  );

/** How `pool` retries: its own settings if it's a `RetryingPool`, else the defaults. */
export const retryOf = (pool: pg.Pool): Partial<Retry> =>
  pool instanceof RetryingPool ? pool.retry : {};
