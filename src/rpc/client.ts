import { promisify } from "node:util";
import { zstdDecompress as zstdCallback } from "node:zlib";
import { chunks } from "../utils/chunks.ts";
import { sleep } from "../utils/sleep.ts";

const zstdDecompress = promisify(zstdCallback);
const utf8 = new TextDecoder();

export class RpcError extends Error {
  readonly method: string;
  readonly code: number;
  readonly data: unknown;

  constructor(method: string, code: number, message: string, data?: unknown) {
    super(`${method}: ${code} ${message}`);
    this.method = method;
    this.code = code;
    this.data = data;
  }
}

/**
 * `methods`: calls per JSON-RPC method (what providers bill), retries included. Retried failures by kind:
 * `throttled` (429), `timeouts`, `failed` (anything else retryable: 5xx, transport, node internal errors).
 */
export type RpcStats = {
  requests: number;
  calls: number;
  retries: number;
  throttled: number;
  timeouts: number;
  failed: number;
  bytes: number;
  methods: Record<string, number>;
};

export type RpcClientOptions = {
  timeoutMs?: number;
  /** Requests in flight at most. */
  maxConcurrency?: number;
  /** Calls per second to start at; the limit then follows what the endpoint takes. */
  initialRate?: number;
  maxRate?: number;
  maxAttempts?: number;
};

const MIN_RATE = 5;
const INITIAL_PAUSE_MS = 100;
const MAX_PAUSE_MS = 5_000;

type Call = { method: string; params: unknown };
type Response = {
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

/** Errors worth retrying: transport failures, timeouts, throttling, node-side internal errors. */
function retryable(status: number | undefined, code?: number): boolean {
  if (status !== undefined && (status === 429 || status >= 500)) return true;
  return code === -32603 || code === -32005 || code === 429;
}

/**
 * JSON-RPC over HTTP, paced in calls per second (calls inside a batch count one by one: that's what providers rate
 * and bill), after Ponder's limiter. The rate doubles until the first throttle, which halves it; after that it grows
 * 5% per 5 s worth of successes while sends are waiting on it, and drops 5% on each throttle or timeout, which also
 * pauses sending (100 ms, then ×1.5 per throttle in a row, up to 5 s).
 */
export class RpcClient {
  readonly stats: RpcStats = {
    requests: 0,
    calls: 0,
    retries: 0,
    throttled: 0,
    timeouts: 0,
    failed: 0,
    bytes: 0,
    methods: {},
  };
  readonly #url: string;
  readonly #timeoutMs: number;
  readonly #maxConcurrency: number;
  readonly #maxRate: number;
  readonly #maxAttempts: number;
  #rate: number;
  #slowStart = true;
  /** Calls answered since the rate last changed, and whether any send waited on it meanwhile. */
  #succeeded = 0;
  #bound = false;
  /** Calls that may go out now: refills at the rate, up to a second's worth. */
  #tokens: number;
  #refilled = Date.now();
  /** Sends take tokens one at a time, in order. */
  #gate: Promise<void> = Promise.resolve();
  #pausedUntil = 0;
  #pauseMs = INITIAL_PAUSE_MS;
  #active = 0;
  #waiting: (() => void)[] = [];
  #id = 0;

  constructor(url: string, options: RpcClientOptions = {}) {
    this.#url = url;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#maxConcurrency = options.maxConcurrency ?? 64;
    this.#rate = options.initialRate ?? 100;
    this.#tokens = this.#rate;
    this.#maxRate = options.maxRate ?? 10_000;
    this.#maxAttempts = options.maxAttempts ?? 8;
  }

  /** The current limit, in calls per second. */
  get rate(): number {
    return Math.floor(this.#rate);
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    const [result] = await this.batch<[T]>([{ method, params }]);
    return result;
  }

  /**
   * Sends calls in one HTTP request, or several when the batch is larger than a second's worth of calls. Resolves in
   * call order. Calls that fail with a retryable error (a throttled call inside an otherwise fine batch, for one) are
   * sent again on their own; any other call error rejects.
   */
  async batch<T extends unknown[]>(calls: Call[]): Promise<T> {
    const size = Math.max(1, Math.floor(this.#rate));
    if (calls.length <= size) return this.#batch(calls) as Promise<T>;
    const parts = await Promise.all([...chunks(calls, size)].map((c) => this.#batch(c)));
    return parts.flat() as T;
  }

  async #batch(calls: Call[]): Promise<unknown[]> {
    const results = new Array<unknown>(calls.length);
    let pending = calls.map((_, i) => i);
    for (let attempt = 1; ; attempt++) {
      await this.#acquire();
      await this.#pace(pending.length);
      let status: number | undefined;
      let failure: unknown;
      try {
        const answers = await this.#send(
          pending.map((i) => calls[i]!),
          (s) => (status = s),
        );
        const again: number[] = [];
        answers.forEach((a, j) => {
          if (!(a instanceof RpcError)) results[pending[j]!] = a;
          else if (retryable(undefined, a.code)) {
            again.push(pending[j]!);
            failure = a;
          } else throw a;
        });
        this.#answered(calls.length - again.length);
        pending = again;
        if (pending.length === 0) return results;
      } catch (e) {
        const code = e instanceof RpcError ? e.code : undefined;
        if (e instanceof RpcError && !retryable(status, code)) throw e;
        failure = e;
      } finally {
        this.#release();
      }
      const code = failure instanceof RpcError ? failure.code : undefined;
      // Throttling only slows us down: it never uses up attempts, other failures do.
      const throttled = status === 429 || code === 429 || code === -32005;
      const timeout = (failure as Error).name === "TimeoutError";
      if (throttled) this.stats.throttled++;
      else if (timeout) this.stats.timeouts++;
      else this.stats.failed++;
      if (throttled || timeout) this.#slowDown(timeout);
      this.stats.retries++;
      // A throttle waits out the pause and never uses up attempts; other failures back off and do.
      if (throttled) attempt--;
      else if (attempt >= this.#maxAttempts) throw failure;
      else await sleep(Math.min(10_000, 200 * 2 ** (attempt - 1)) * (0.5 + Math.random()));
    }
  }

  /** Waits for `n` calls' worth of tokens, at the rate as it is while waiting. */
  #pace(n: number): Promise<void> {
    const turn = this.#gate.then(async () => {
      for (;;) {
        const now = Date.now();
        if (now < this.#pausedUntil) {
          await sleep(this.#pausedUntil - now);
          continue;
        }
        this.#tokens = Math.min(
          this.#rate,
          this.#tokens + ((now - this.#refilled) * this.#rate) / 1000,
        );
        this.#refilled = now;
        const need = Math.min(n, this.#rate);
        if (this.#tokens >= need) {
          this.#tokens -= n;
          return;
        }
        this.#bound = true;
        await sleep(Math.max(1, ((need - this.#tokens) * 1000) / this.#rate));
      }
    });
    this.#gate = turn;
    return turn;
  }

  #answered(n: number) {
    if (n === 0) return;
    this.#pauseMs = INITIAL_PAUSE_MS;
    this.#succeeded += n;
    if (!this.#bound || this.#succeeded < (this.#slowStart ? 1 : 5) * this.#rate) return;
    this.#rate = Math.min(this.#maxRate, this.#rate * (this.#slowStart ? 2 : 1.05));
    this.#succeeded = 0;
    this.#bound = false;
  }

  /** One throttle per pause counts: requests already in flight when it began were sent at the old rate. */
  #slowDown(timeout: boolean) {
    const now = Date.now();
    if (now < this.#pausedUntil) return;
    this.#rate = Math.max(MIN_RATE, this.#rate * (this.#slowStart ? 0.5 : 0.95));
    this.#slowStart = false;
    this.#succeeded = 0;
    this.#bound = false;
    this.#pausedUntil = now + this.#pauseMs;
    this.#tokens = 0;
    this.#refilled = this.#pausedUntil;
    this.#pauseMs = timeout ? INITIAL_PAUSE_MS : Math.min(MAX_PAUSE_MS, this.#pauseMs * 1.5);
  }

  /** One HTTP request: per call its result or its `RpcError`. Throws for transport and HTTP errors. */
  async #send(calls: Call[], onStatus: (status: number) => void): Promise<unknown[]> {
    const first = this.#id;
    const body = calls.map((c, i) => ({
      jsonrpc: "2.0",
      id: first + i,
      method: c.method,
      params: c.params,
    }));
    this.#id += calls.length;
    this.stats.requests++;
    this.stats.calls += calls.length;
    for (const c of calls) this.stats.methods[c.method] = (this.stats.methods[c.method] ?? 0) + 1;
    const res = await fetch(this.#url, {
      method: "POST",
      headers: { "content-type": "application/json", "accept-encoding": "zstd, br, gzip" },
      body: JSON.stringify(calls.length === 1 ? body[0] : body),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    onStatus(res.status);
    // fetch decodes br and gzip itself, and zstd too in newer Node 24 (still labelled zstd): the frame magic tells.
    const bytes = new Uint8Array(await res.arrayBuffer());
    const zstd =
      res.headers.get("content-encoding") === "zstd" &&
      bytes[0] === 0x28 &&
      bytes[1] === 0xb5 &&
      bytes[2] === 0x2f &&
      bytes[3] === 0xfd;
    const text = utf8.decode(zstd ? await zstdDecompress(bytes) : bytes);
    this.stats.bytes += text.length;
    if (!res.ok)
      throw new RpcError(calls[0]!.method, res.status, `HTTP ${res.status}: ${text.slice(0, 200)}`);
    const parsed = JSON.parse(text) as Response | Response[];
    const responses = Array.isArray(parsed) ? parsed : [parsed];
    const byId = new Map(responses.map((r) => [r.id, r]));
    return calls.map((c, i) => {
      const r = byId.get(first + i);
      if (r === undefined) return new RpcError(c.method, -32603, "missing response in batch");
      if (r.error !== undefined)
        return new RpcError(c.method, r.error.code, r.error.message, r.error.data);
      return r.result;
    });
  }

  async #acquire(): Promise<void> {
    while (this.#active >= this.#maxConcurrency)
      await new Promise<void>((r) => this.#waiting.push(r));
    this.#active++;
  }

  #release() {
    this.#active--;
    this.#waiting.shift()?.();
  }
}
