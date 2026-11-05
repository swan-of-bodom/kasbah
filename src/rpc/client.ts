import { promisify } from "node:util";
import { zstdDecompress as zstdCallback } from "node:zlib";
import { chunks } from "../utils/chunks.ts";
import { Stopped } from "../utils/errors.ts";
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

/** One JSON-RPC endpoint: its URL, and optionally the calls per second it may take at most. */
export type RpcEndpoint = { url: string; maxRequestsPerSecond?: number };

/** One endpoint's state for the dashboard. */
export type EndpointStats = {
  host: string;
  rate: number;
  calls: number;
  throttled: number;
  failed: number;
  /** Mean time to an answer, recent calls weighted most; 0 before the first. */
  latencyMs: number;
  /** As `latencyMs`, to the answer's headers only: the endpoint's own time, without reading the body. */
  headersMs: number;
};

export type RpcClientOptions = {
  timeoutMs?: number;
  /** Requests in flight at most, over every endpoint. */
  maxConcurrency?: number;
  /** Calls per second to start at, per endpoint; the limit then follows what each takes. */
  initialRate?: number;
  maxRate?: number;
  maxAttempts?: number;
  /** The transport, for tests: a fake node with no sockets, under fake timers. */
  fetch?: typeof fetch;
  /** Once aborted, requests in flight and every later one throw `Stopped`, without retrying. */
  signal?: AbortSignal;
};

/** A request with no answer by then is a timeout, retried like a transport failure. */
const TIMEOUT_MS = 30_000;
/** Requests in flight at most, unless the caller sets `maxConcurrency`. */
const MAX_CONCURRENCY = 64;
/**
 * An endpoint's calls-per-second limit. It starts at `initial` and, in the slow start, doubles each time a second's
 * worth of calls succeeds; the first throttle or timeout halves it and ends the slow start. After that it grows 5% per
 * five seconds' worth of successes and falls 5% per throttle, staying between `min` and `max`.
 */
const RATE = {
  initial: 100,
  min: 5,
  max: 10_000,
  /** Before the first throttle: growth per step, the step in seconds' worth of successes, and the cut that ends it. */
  slowStart: { growth: 2, stepS: 1, cut: 0.5 },
  /** After it. */
  steady: { growth: 1.05, stepS: 5, cut: 0.95 },
};
/**
 * Retries of failures that aren't throttling (throttled tries don't count): `attempts` tries per call, the backoff
 * starting at `backoffMs` and doubling per attempt up to `maxBackoffMs`, then given ±50% jitter.
 */
const RETRY = { attempts: 8, backoffMs: 200, maxBackoffMs: 10_000 };
/** Pause of all requests after a throttle, growing `growth` times per throttle in a row up to `maxMs`. */
const PAUSE = { initialMs: 100, maxMs: 5_000, growth: 1.5 };
/**
 * Picking an endpoint: `explore` is the share of requests sent to a random ready one instead of the fastest, so a slow
 * one that recovers is noticed; `latencyWeight` is the weight of the newest answer in an endpoint's mean latency.
 */
const PICK = { explore: 0.05, latencyWeight: 0.1 };
/** `getEvents` continuation tokens remembered with the endpoint that issued them, oldest dropped first. */
const MAX_TOKENS = 10_000;

type Call = { method: string; params: unknown };
type Response = {
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

/**
 * Error codes: JSON-RPC's internal error, which nodes also send for a failure on their side worth retrying; "limit
 * exceeded", how some providers throttle instead of HTTP 429; and 429, which others also send as a code.
 */
const CODES = { internalError: -32603, limitExceeded: -32005, tooManyRequests: 429 };

const throttles = (status: number | undefined, code: number | undefined) =>
  status === CODES.tooManyRequests ||
  code === CODES.tooManyRequests ||
  code === CODES.limitExceeded;

function retryable(status: number | undefined, code?: number): boolean {
  if (throttles(status, code)) return true;
  return (status !== undefined && status >= 500) || code === CODES.internalError;
}

/**
 * Whether the client tries a call again after `e`: a timeout, a lost connection, a throttle, or a failure on the node's
 * or its gateway's side. A caller that asked for one attempt can then try a smaller call.
 */
export function retried(e: unknown): boolean {
  if (e instanceof Stopped) return false;
  if (!(e instanceof RpcError)) return true;
  return retryable(e.code >= 100 && e.code < 600 ? e.code : undefined, e.code);
}

class Endpoint {
  readonly url: string;
  readonly host: string;
  maxRate: number;
  rate: number;
  slowStart = true;
  succeeded = 0;
  waitedForRate = false;
  tokens: number;
  refilled = Date.now();
  gate: Promise<void> = Promise.resolve();
  pausedUntil = 0;
  pauseMs = PAUSE.initialMs;
  active = 0;
  claimed = 0;
  latencyMs = 0;
  headersMs = 0;
  calls = 0;
  throttled = 0;
  failed = 0;

  constructor(e: RpcEndpoint, initialRate: number, maxRate: number) {
    this.url = e.url;
    this.host = hostOf(e.url);
    this.maxRate = Math.max(1, e.maxRequestsPerSecond ?? maxRate);
    this.rate = Math.min(initialRate, this.maxRate);
    this.tokens = this.rate;
  }

  waitMs(n: number, now: number): number {
    if (now < this.pausedUntil) return this.pausedUntil - now;
    const tokens =
      Math.min(this.rate, this.tokens + ((now - this.refilled) * this.rate) / 1000) - this.claimed;
    const need = Math.min(n, this.rate);
    return tokens >= need ? 0 : ((need - tokens) * 1000) / this.rate;
  }

  pace(n: number): Promise<void> {
    const turn = this.gate.then(async () => {
      for (;;) {
        const now = Date.now();
        if (now < this.pausedUntil) {
          await sleep(this.pausedUntil - now);
          continue;
        }
        this.tokens = Math.min(this.rate, this.tokens + ((now - this.refilled) * this.rate) / 1000);
        this.refilled = now;
        const need = Math.min(n, this.rate);
        if (this.tokens >= need) {
          this.tokens -= n;
          return;
        }
        this.waitedForRate = true;
        await sleep(Math.max(1, ((need - this.tokens) * 1000) / this.rate));
      }
    });
    this.gate = turn;
    return turn;
  }

  answered(n: number, ms: number) {
    this.latencyMs =
      this.latencyMs === 0 ? ms : this.latencyMs + (ms - this.latencyMs) * PICK.latencyWeight;
    if (n === 0) return;
    this.pauseMs = PAUSE.initialMs;
    this.succeeded += n;
    const phase = this.slowStart ? RATE.slowStart : RATE.steady;
    if (!this.waitedForRate || this.succeeded < phase.stepS * this.rate) return;
    this.rate = Math.min(this.maxRate, this.rate * phase.growth);
    this.succeeded = 0;
    this.waitedForRate = false;
  }

  /** One throttle per pause counts: requests already in flight when it began were sent at the old rate. */
  slowDown(timeout: boolean) {
    const now = Date.now();
    if (now < this.pausedUntil) return;
    this.rate = Math.max(
      Math.min(RATE.min, this.maxRate),
      this.rate * (this.slowStart ? RATE.slowStart : RATE.steady).cut,
    );
    this.slowStart = false;
    this.succeeded = 0;
    this.waitedForRate = false;
    this.pausedUntil = now + this.pauseMs;
    this.tokens = 0;
    this.refilled = this.pausedUntil;
    // Whole milliseconds: a pause ending mid-millisecond would wake on it again, since Date.now() can't pass it.
    this.pauseMs = timeout
      ? PAUSE.initialMs
      : Math.min(PAUSE.maxMs, Math.round(this.pauseMs * PAUSE.growth));
  }
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const tokenOf = (c: Call): string | undefined =>
  c.method === "starknet_getEvents"
    ? (c.params as { filter?: { continuation_token?: string } })?.filter?.continuation_token
    : undefined;

/**
 * JSON-RPC over HTTP to one endpoint or several, each paced in calls per second (calls inside a batch count one by
 * one: that's what providers rate and bill). A request goes to the endpoint that can send it soonest, the fastest
 * of those when several can at once; a retry goes elsewhere when it can. A `getEvents` page with a continuation token
 * goes to the endpoint that issued the token: tokens are node-specific.
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
  readonly #endpoints: Endpoint[];
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxConcurrency: number;
  readonly #maxAttempts: number;
  readonly #signal: AbortSignal | undefined;
  readonly #issuers = new Map<string, Endpoint>();
  #active = 0;
  #waiting: (() => void)[] = [];
  #id = 0;

  constructor(rpc: string | readonly (string | RpcEndpoint)[], options: RpcClientOptions = {}) {
    const endpoints = (typeof rpc === "string" ? [rpc] : rpc).map((e) =>
      typeof e === "string" ? { url: e } : e,
    );
    if (endpoints.length === 0) throw new Error("no RPC endpoint");
    const initial = options.initialRate ?? RATE.initial;
    const max = options.maxRate ?? RATE.max;
    this.#endpoints = endpoints.map((e) => new Endpoint(e, initial, max));
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    this.#maxConcurrency = options.maxConcurrency ?? MAX_CONCURRENCY;
    this.#maxAttempts = options.maxAttempts ?? RETRY.attempts;
    this.#signal = options.signal;
  }

  /**
   * The endpoints for another client, each with `share` of its ceiling, which this client gives up until `repay`:
   * together they keep to an endpoint's `maxRequestsPerSecond` (but for a call per second each, at the least).
   */
  lend(share: number): { endpoints: RpcEndpoint[]; repay: () => void } {
    const lent = this.#endpoints.map((e) => {
      const n = Math.max(1, Math.floor(e.maxRate * share));
      e.maxRate = Math.max(1, e.maxRate - n);
      e.rate = Math.min(e.rate, e.maxRate);
      e.tokens = Math.min(e.tokens, e.rate);
      return n;
    });
    let repaid = false;
    return {
      endpoints: this.#endpoints.map((e, i) => ({ url: e.url, maxRequestsPerSecond: lent[i]! })),
      repay: () => {
        if (repaid) return;
        repaid = true;
        for (const [i, e] of this.#endpoints.entries()) e.maxRate += lent[i]!;
      },
    };
  }

  /** The current limit over every endpoint, in calls per second. */
  get rate(): number {
    return this.#endpoints.reduce((n, e) => n + Math.floor(e.rate), 0);
  }

  get endpoints(): EndpointStats[] {
    return this.#endpoints.map((e) => ({
      host: e.host,
      rate: Math.floor(e.rate),
      calls: e.calls,
      throttled: e.throttled,
      failed: e.failed,
      latencyMs: Math.round(e.latencyMs),
      headersMs: Math.round(e.headersMs),
    }));
  }

  /** One call. `attempts`: tries for failures that aren't throttling (default: the client's `maxAttempts`). */
  async request<T>(method: string, params: unknown, o: { attempts?: number } = {}): Promise<T> {
    const [result] = await this.batch<[T]>([{ method, params }], o);
    return result;
  }

  /** The same call on every endpoint, in their order: to check they agree (the chain they're on). */
  async requestEach<T>(method: string, params: unknown): Promise<T[]> {
    return Promise.all(
      this.#endpoints.map(
        async (e) => (await this.#batch([{ method, params }], { pinned: e }))[0] as T,
      ),
    );
  }

  /**
   * Sends calls in one HTTP request, or several when the batch is larger than a second's worth of calls. Resolves in
   * call order. Calls that fail with a retryable error (a throttled call inside an otherwise fine batch, for one) are
   * sent again on their own; any other call error rejects, or with `settle` takes that call's place as its `RpcError`.
   */
  async batch<T extends unknown[]>(
    calls: Call[],
    o: { settle?: boolean; attempts?: number } = {},
  ): Promise<T> {
    const size = Math.max(1, Math.max(...this.#endpoints.map((e) => Math.floor(e.rate))));
    if (calls.length <= size) return this.#batch(calls, o) as Promise<T>;
    const parts = await Promise.all([...chunks(calls, size)].map((c) => this.#batch(c, o)));
    return parts.flat() as T;
  }

  #pick(n: number, avoid: Endpoint | undefined): Endpoint {
    const all = this.#endpoints;
    if (all.length === 1) return all[0]!;
    const now = Date.now();
    const candidates = avoid === undefined ? all : all.filter((e) => e !== avoid);
    const ready = candidates.filter((e) => e.waitMs(n, now) === 0);
    if (ready.length > 1 && Math.random() < PICK.explore)
      return ready[Math.floor(Math.random() * ready.length)]!;
    const key = (e: Endpoint) => [e.waitMs(n, now), e.latencyMs, e.active];
    return candidates.reduce((best, e) => {
      const [x, y] = [key(e), key(best)];
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? e : best;
      return best;
    });
  }

  #issuer(calls: Call[]): Endpoint | undefined {
    if (this.#endpoints.length === 1) return undefined;
    for (const c of calls) {
      const token = tokenOf(c);
      if (token !== undefined) return this.#issuers.get(token);
    }
    return undefined;
  }

  #remember(e: Endpoint, answers: unknown[]) {
    if (this.#endpoints.length === 1) return;
    for (const a of answers) {
      const token = (a as { continuation_token?: unknown } | null)?.continuation_token;
      if (typeof token !== "string") continue;
      this.#issuers.set(token, e);
      if (this.#issuers.size > MAX_TOKENS)
        this.#issuers.delete(this.#issuers.keys().next().value as string);
    }
  }

  async #batch(
    calls: Call[],
    o: { settle?: boolean; attempts?: number; pinned?: Endpoint },
  ): Promise<unknown[]> {
    const settle = o.settle === true;
    const pinned = o.pinned;
    const attempts = o.attempts ?? this.#maxAttempts;
    const results = new Array<unknown>(calls.length);
    let pending = calls.map((_, i) => i);
    const issuer = pinned ?? this.#issuer(calls);
    let avoid: Endpoint | undefined;
    for (let attempt = 1; ; attempt++) {
      if (this.#signal?.aborted) throw new Stopped();
      await this.#acquire();
      const endpoint = issuer ?? this.#pick(pending.length, avoid);
      endpoint.active++;
      const n = pending.length;
      endpoint.claimed += n;
      let status: number | undefined;
      let failure: unknown;
      try {
        await endpoint.pace(n).finally(() => (endpoint.claimed -= n));
        const sent = Date.now();
        const answers = await this.#send(
          endpoint,
          pending.map((i) => calls[i]!),
          (s) => (status = s),
        );
        const again: number[] = [];
        answers.forEach((a, j) => {
          if (!(a instanceof RpcError)) results[pending[j]!] = a;
          else if (retryable(undefined, a.code)) {
            again.push(pending[j]!);
            failure = a;
          } else if (settle) results[pending[j]!] = a;
          else throw a;
        });
        endpoint.answered(pending.length - again.length, Date.now() - sent);
        this.#remember(endpoint, answers);
        pending = again;
        if (pending.length === 0) return results;
      } catch (e) {
        if (this.#signal?.aborted) throw new Stopped();
        const code = e instanceof RpcError ? e.code : undefined;
        if (e instanceof RpcError && !retryable(status, code)) throw e;
        failure = e;
      } finally {
        endpoint.active--;
        this.#release();
      }
      avoid = endpoint;
      const code = failure instanceof RpcError ? failure.code : undefined;
      const throttled = throttles(status, code);
      const timeout = (failure as Error).name === "TimeoutError";
      if (throttled) {
        this.stats.throttled++;
        endpoint.throttled++;
      } else {
        if (timeout) this.stats.timeouts++;
        else this.stats.failed++;
        endpoint.failed++;
      }
      if (throttled || timeout) endpoint.slowDown(timeout);
      this.stats.retries++;
      if (throttled) attempt--;
      else if (attempt >= attempts) throw failure;
      else
        await sleep(
          Math.min(RETRY.maxBackoffMs, RETRY.backoffMs * 2 ** (attempt - 1)) *
            (0.5 + Math.random()),
          this.#signal,
        );
    }
  }

  async #send(
    endpoint: Endpoint,
    calls: Call[],
    onStatus: (status: number) => void,
  ): Promise<unknown[]> {
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
    endpoint.calls += calls.length;
    for (const c of calls) this.stats.methods[c.method] = (this.stats.methods[c.method] ?? 0) + 1;
    const sent = Date.now();
    const res = await this.#fetch(endpoint.url, {
      method: "POST",
      headers: { "content-type": "application/json", "accept-encoding": "zstd, br, gzip" },
      body: JSON.stringify(calls.length === 1 ? body[0] : body),
      signal:
        this.#signal === undefined
          ? AbortSignal.timeout(this.#timeoutMs)
          : AbortSignal.any([AbortSignal.timeout(this.#timeoutMs), this.#signal]),
    });
    const ms = Date.now() - sent;
    endpoint.headersMs =
      endpoint.headersMs === 0
        ? ms
        : endpoint.headersMs + (ms - endpoint.headersMs) * PICK.latencyWeight;
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
      if (r === undefined)
        return new RpcError(c.method, CODES.internalError, "missing response in batch");
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
