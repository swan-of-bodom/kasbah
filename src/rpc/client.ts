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
/** Calls per second at the start: the limit doubles from here until the endpoint first throttles. */
const INITIAL_RATE = 100;
/** The limit never climbs above this, however fast the endpoint answers. */
const MAX_RATE = 10_000;
/** The limit never falls below this, however often the endpoint throttles. */
const MIN_RATE = 5;
/** Tries per call for failures that aren't throttling (throttled tries don't count). */
const MAX_ATTEMPTS = 8;
/** First retry backoff; it doubles per attempt up to `MAX_BACKOFF_MS`, then gets ±50% jitter. */
const BACKOFF_MS = 200;
const MAX_BACKOFF_MS = 10_000;
/** Pause of all requests after a throttle, growing `PAUSE_GROWTH` per throttle in a row up to `MAX_PAUSE_MS`. */
const INITIAL_PAUSE_MS = 100;
const MAX_PAUSE_MS = 5_000;
const PAUSE_GROWTH = 1.5;
/** Rate growth per step before the first throttle (slow start), and after it. */
const SLOW_START_GROWTH = 2;
const GROWTH = 1.05;
/** Successes needed for a step, in seconds' worth at the current rate: before the first throttle, and after. */
const SLOW_START_STEP_S = 1;
const STEP_S = 5;
/** Rate cut on the first throttle or timeout, which ends the slow start, and on each one after. */
const SLOW_START_CUT = 0.5;
const CUT = 0.95;
/** Share of requests sent to a random ready endpoint instead of the fastest, so a slow one that recovers is noticed. */
const EXPLORE = 0.05;
/** Weight of the newest answer in an endpoint's mean latency. */
const LATENCY_WEIGHT = 0.1;
/** `getEvents` continuation tokens remembered with the endpoint that issued them, oldest dropped first. */
const MAX_TOKENS = 10_000;

type Call = { method: string; params: unknown };
type Response = {
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

/** JSON-RPC's internal error, which nodes also send for a failure on their side worth retrying. */
const INTERNAL_ERROR = -32603;
/** "Limit exceeded": how some providers throttle, instead of HTTP 429 (which others also send as a code). */
const LIMIT_EXCEEDED = -32005;
const TOO_MANY_REQUESTS = 429;

const throttles = (status: number | undefined, code: number | undefined) =>
  status === TOO_MANY_REQUESTS || code === TOO_MANY_REQUESTS || code === LIMIT_EXCEEDED;

function retryable(status: number | undefined, code?: number): boolean {
  if (throttles(status, code)) return true;
  return (status !== undefined && status >= 500) || code === INTERNAL_ERROR;
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
  pauseMs = INITIAL_PAUSE_MS;
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
      this.latencyMs === 0 ? ms : this.latencyMs + (ms - this.latencyMs) * LATENCY_WEIGHT;
    if (n === 0) return;
    this.pauseMs = INITIAL_PAUSE_MS;
    this.succeeded += n;
    const step = this.slowStart ? SLOW_START_STEP_S : STEP_S;
    if (!this.waitedForRate || this.succeeded < step * this.rate) return;
    this.rate = Math.min(this.maxRate, this.rate * (this.slowStart ? SLOW_START_GROWTH : GROWTH));
    this.succeeded = 0;
    this.waitedForRate = false;
  }

  /** One throttle per pause counts: requests already in flight when it began were sent at the old rate. */
  slowDown(timeout: boolean) {
    const now = Date.now();
    if (now < this.pausedUntil) return;
    this.rate = Math.max(
      Math.min(MIN_RATE, this.maxRate),
      this.rate * (this.slowStart ? SLOW_START_CUT : CUT),
    );
    this.slowStart = false;
    this.succeeded = 0;
    this.waitedForRate = false;
    this.pausedUntil = now + this.pauseMs;
    this.tokens = 0;
    this.refilled = this.pausedUntil;
    // Whole milliseconds: a pause ending mid-millisecond would wake on it again, since Date.now() can't pass it.
    this.pauseMs = timeout
      ? INITIAL_PAUSE_MS
      : Math.min(MAX_PAUSE_MS, Math.round(this.pauseMs * PAUSE_GROWTH));
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
    const initial = options.initialRate ?? INITIAL_RATE;
    const max = options.maxRate ?? MAX_RATE;
    this.#endpoints = endpoints.map((e) => new Endpoint(e, initial, max));
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    this.#maxConcurrency = options.maxConcurrency ?? MAX_CONCURRENCY;
    this.#maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
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

  async request<T>(method: string, params: unknown): Promise<T> {
    const [result] = await this.batch<[T]>([{ method, params }]);
    return result;
  }

  /** The same call on every endpoint, in their order: to check they agree (the chain they're on). */
  async requestEach<T>(method: string, params: unknown): Promise<T[]> {
    return Promise.all(
      this.#endpoints.map(async (e) => (await this.#batch([{ method, params }], false, e))[0] as T),
    );
  }

  /**
   * Sends calls in one HTTP request, or several when the batch is larger than a second's worth of calls. Resolves in
   * call order. Calls that fail with a retryable error (a throttled call inside an otherwise fine batch, for one) are
   * sent again on their own; any other call error rejects, or with `settle` takes that call's place as its `RpcError`.
   */
  async batch<T extends unknown[]>(calls: Call[], o: { settle?: boolean } = {}): Promise<T> {
    const settle = o.settle === true;
    const size = Math.max(1, Math.max(...this.#endpoints.map((e) => Math.floor(e.rate))));
    if (calls.length <= size) return this.#batch(calls, settle) as Promise<T>;
    const parts = await Promise.all([...chunks(calls, size)].map((c) => this.#batch(c, settle)));
    return parts.flat() as T;
  }

  #pick(n: number, avoid: Endpoint | undefined): Endpoint {
    const all = this.#endpoints;
    if (all.length === 1) return all[0]!;
    const now = Date.now();
    const candidates = avoid === undefined ? all : all.filter((e) => e !== avoid);
    const ready = candidates.filter((e) => e.waitMs(n, now) === 0);
    if (ready.length > 1 && Math.random() < EXPLORE)
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

  async #batch(calls: Call[], settle: boolean, pinned?: Endpoint): Promise<unknown[]> {
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
      else if (attempt >= this.#maxAttempts) throw failure;
      else
        await sleep(
          Math.min(MAX_BACKOFF_MS, BACKOFF_MS * 2 ** (attempt - 1)) * (0.5 + Math.random()),
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
        : endpoint.headersMs + (ms - endpoint.headersMs) * LATENCY_WEIGHT;
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
        return new RpcError(c.method, INTERNAL_ERROR, "missing response in batch");
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
