import { errorCode, Stopped } from "../utils/errors.ts";
import { sleep } from "../utils/sleep.ts";

/**
 * After a lost database connection: up to 9 more tries, waiting about 125 ms and twice as long each time (~1 min in
 * all): long enough for Postgres to restart or a managed database to fail over. Each wait is between half and all
 * of its step, at random, so retries don't fall in step with an outage's rhythm or with each other.
 */
export const DB_RETRY = { tries: 10, firstWaitMs: 125 };

/** How a pool retries, and who hears about it. */
export type Retry = {
  tries: number;
  firstWaitMs: number;
  signal?: AbortSignal;
  /** Before each wait: the error, the retry about to happen (from 1) and the wait. */
  onRetry?: (error: unknown, retry: number, waitMs: number) => void;
  /** After a success that needed retries. */
  onBack?: (retries: number) => void;
};

/**
 * Postgres's connection exceptions (class 08), a server shutting down or starting (57P01–57P03), too many clients
 * (53300), and Node's network errors.
 */
const LOST_CODES = new Set([
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "57P01",
  "57P02",
  "57P03",
  "53300",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
]);

/** node-postgres's own errors for a connection that ended, which carry no code. */
const LOST_MESSAGES =
  /Connection terminated|connection to client lost|timeout exceeded when trying to connect|not queryable|Client was closed/i;

/** The error, or what caused it, says the connection to Postgres was lost: worth trying again. */
export function lostConnection(e: unknown): boolean {
  for (let x = e, depth = 0; x !== undefined && x !== null && depth < 4; depth++) {
    const code = errorCode(x);
    if (code !== undefined && LOST_CODES.has(code)) return true;
    if (LOST_MESSAGES.test(String((x as { message?: unknown }).message ?? ""))) return true;
    x = (x as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * `fn(attempt)` until it doesn't fail with a lost connection, waiting longer each time; any other error, the last
 * try's error, or a stop ends it.
 */
export async function retrying<T>(
  fn: (attempt: number) => Promise<T>,
  retry: Partial<Retry> = {},
): Promise<T> {
  const { tries, firstWaitMs, signal, onRetry, onBack } = { ...DB_RETRY, ...retry };
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await fn(attempt);
      if (attempt > 0) onBack?.(attempt);
      return out;
    } catch (e) {
      if (!lostConnection(e) || attempt + 1 >= tries) throw e;
      if (signal?.aborted) throw new Stopped();
      const waitMs = Math.round(firstWaitMs * 2 ** attempt * (0.5 + Math.random() / 2));
      onRetry?.(e, attempt + 1, waitMs);
      await sleep(waitMs, signal);
      if (signal?.aborted) throw new Stopped();
    }
  }
}
