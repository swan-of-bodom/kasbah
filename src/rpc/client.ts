import { promisify } from "node:util";
import { zstdDecompress as zstdCallback } from "node:zlib";

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

/** `methods`: calls per JSON-RPC method (what providers bill), retries included. */
export type RpcStats = { requests: number; calls: number; retries: number; throttled: number; bytes: number; methods: Record<string, number> };

export type RpcClientOptions = {
  timeoutMs?: number;
  initialConcurrency?: number;
  maxConcurrency?: number;
  maxAttempts?: number;
};

type Call = { method: string; params: unknown };
type Response = { id: number; result?: unknown; error?: { code: number; message: string; data?: unknown } };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Errors worth retrying: transport failures, timeouts, throttling, node-side internal errors. */
function retryable(status: number | undefined, code?: number): boolean {
  if (status !== undefined && (status === 429 || status >= 500)) return true;
  return code === -32603 || code === -32005 || code === 429;
}

/**
 * JSON-RPC over HTTP with AIMD concurrency: the in-flight limit grows by about one per round of successes and halves
 * on throttling or timeouts, so one client finds what an endpoint can take.
 */
export class RpcClient {
  readonly stats: RpcStats = { requests: 0, calls: 0, retries: 0, throttled: 0, bytes: 0, methods: {} };
  readonly #url: string;
  readonly #timeoutMs: number;
  readonly #maxConcurrency: number;
  readonly #maxAttempts: number;
  #limit: number;
  #active = 0;
  #waiting: (() => void)[] = [];
  #id = 0;

  constructor(url: string, options: RpcClientOptions = {}) {
    this.#url = url;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#limit = options.initialConcurrency ?? 8;
    this.#maxConcurrency = options.maxConcurrency ?? 64;
    this.#maxAttempts = options.maxAttempts ?? 8;
  }

  get concurrency(): number {
    return Math.floor(this.#limit);
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    const [result] = await this.batch<[T]>([{ method, params }]);
    return result;
  }

  /**
   * Sends calls in one HTTP request. Resolves in call order. Calls that fail with a retryable error (a throttled
   * call inside an otherwise fine batch, for one) are sent again on their own; any other call error rejects.
   */
  async batch<T extends unknown[]>(calls: Call[]): Promise<T> {
    const results = new Array<unknown>(calls.length);
    let pending = calls.map((_, i) => i);
    for (let attempt = 1; ; attempt++) {
      await this.#acquire();
      let status: number | undefined;
      let failure: unknown;
      try {
        const answers = await this.#send(pending.map((i) => calls[i]!), (s) => (status = s));
        const again: number[] = [];
        answers.forEach((a, j) => {
          if (!(a instanceof RpcError)) results[pending[j]!] = a;
          else if (retryable(undefined, a.code)) {
            again.push(pending[j]!);
            failure = a;
          } else throw a;
        });
        pending = again;
        if (pending.length === 0) {
          this.#limit = Math.min(this.#maxConcurrency, this.#limit + 1 / this.#limit);
          return results as T;
        }
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
      if (throttled || (failure as Error).name === "TimeoutError") {
        this.stats.throttled++;
        this.#limit = Math.max(1, this.#limit / 2);
      }
      if (throttled) attempt = Math.min(attempt, 6) - 1;
      else if (attempt >= this.#maxAttempts) throw failure;
      this.stats.retries++;
      await sleep(Math.min(10_000, 200 * 2 ** Math.max(0, attempt - 1)) * (0.5 + Math.random()));
    }
  }

  /** One HTTP request: per call its result or its `RpcError`. Throws for transport and HTTP errors. */
  async #send(calls: Call[], onStatus: (status: number) => void): Promise<unknown[]> {
    const first = this.#id;
    const body = calls.map((c, i) => ({ jsonrpc: "2.0", id: first + i, method: c.method, params: c.params }));
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
    const zstd = res.headers.get("content-encoding") === "zstd" && bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd;
    const text = utf8.decode(zstd ? await zstdDecompress(bytes) : bytes);
    this.stats.bytes += text.length;
    if (!res.ok) throw new RpcError(calls[0]!.method, res.status, `HTTP ${res.status}: ${text.slice(0, 200)}`);
    const parsed = JSON.parse(text) as Response | Response[];
    const responses = Array.isArray(parsed) ? parsed : [parsed];
    const byId = new Map(responses.map((r) => [r.id, r]));
    return calls.map((c, i) => {
      const r = byId.get(first + i);
      if (r === undefined) return new RpcError(c.method, -32603, "missing response in batch");
      if (r.error !== undefined) return new RpcError(c.method, r.error.code, r.error.message, r.error.data);
      return r.result;
    });
  }

  async #acquire(): Promise<void> {
    while (this.#active >= Math.floor(this.#limit)) await new Promise<void>((r) => this.#waiting.push(r));
    this.#active++;
  }

  #release() {
    this.#active--;
    this.#waiting.shift()?.();
  }
}
