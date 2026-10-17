import type { Route } from "../api/routes.ts";
import type { Config, RunOptions } from "../config/app.ts";
import type { Db } from "../db/store.ts";
import type { Client } from "./client.ts";
import { open, type Run } from "./open.ts";
import { backfill } from "./phases/backfill.ts";
import { factories } from "./phases/factories.ts";
import { keys } from "./phases/keys.ts";
import { live } from "./phases/live.ts";
import { Status } from "./status.ts";

export { apiUrl, DEFAULT_SCHEMA } from "./open.ts";

export type AnyHandler = (arg: {
  event: never;
  context: { db: Db; client: Client };
}) => void | Promise<void>;

/** In order, each from where the database is: one with nothing left to do returns at once. */
const PHASES: ((run: Run) => Promise<void>)[] = [factories, backfill, keys, live];

/** Runs the app: setup, then each phase. Reports only through `status`. */
export async function run(
  config: Config,
  handlers: ReadonlyMap<string, AnyHandler>,
  options: RunOptions = {},
  routes: readonly Route[] = [],
): Promise<void> {
  const status = options.status ?? new Status();
  const unsubscribe =
    options.status === undefined
      ? status.subscribe((n) => console.log(`[kasbah] ${n.text}`))
      : undefined;
  const signal = options.signal ?? new AbortController().signal;
  /** Opened resources, closed in reverse whatever happens. */
  const closers: (() => unknown)[] = [];
  let failure: { error: unknown } | undefined;
  try {
    const r = await open(config, handlers, routes, options, status, signal, closers);
    for (const phase of PHASES) {
      if (signal.aborted) break;
      await phase(r);
    }
  } catch (error) {
    failure = { error };
  }
  for (const close of closers.reverse()) {
    try {
      await close();
    } catch (error) {
      // Only when the run itself succeeded: never in place of its error.
      failure ??= { error };
    }
  }
  if (failure === undefined) status.enter("done");
  else status.fail(failure.error);
  unsubscribe?.();
  if (failure !== undefined) throw failure.error;
}
