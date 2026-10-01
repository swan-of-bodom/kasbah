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

export type RpcStats = { requests: number; calls: number; retries: number; throttled: number; bytes: number };

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
  if (status !== undefined) return status === 429 || status >= 500;
  return code === -32603 || code === -32005 || code === 429;
}

/**
 * JSON-RPC over HTTP with AIMD concurrency: the in-flight limit grows by about one per round of successes and halves
 * on throttling or timeouts, so one client finds what an endpoint can take.
 */
export class RpcClient {
  readonly stats: RpcStats = { requests: 0, calls: 0, retries: 0, throttled: 0, bytes: 0 };
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

  /** Sends calls in one HTTP request. Resolves in call order; any call error rejects the whole batch. */
  async batch<T extends unknown[]>(calls: Call[]): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      await this.#acquire();
      let status: number | undefined;
      try {
        const results = await this.#send(calls, (s) => (status = s));
        this.#limit = Math.min(this.#maxConcurrency, this.#limit + 1 / this.#limit);
        return results as T;
      } catch (e) {
        const code = e instanceof RpcError ? e.code : undefined;
        const transport = !(e instanceof RpcError);
        const retry = transport || retryable(status, code);
        if (!retry || attempt >= this.#maxAttempts) throw e;
        if (status === 429 || code === 429 || code === -32005 || (e as Error).name === "TimeoutError") {
          this.stats.throttled++;
          this.#limit = Math.max(1, this.#limit / 2);
        }
        this.stats.retries++;
        await sleep(Math.min(10_000, 200 * 2 ** (attempt - 1)) * (0.5 + Math.random()));
      } finally {
        this.#release();
      }
    }
  }

  async #send(calls: Call[], onStatus: (status: number) => void): Promise<unknown[]> {
    const first = this.#id;
    const body = calls.map((c, i) => ({ jsonrpc: "2.0", id: first + i, method: c.method, params: c.params }));
    this.#id += calls.length;
    this.stats.requests++;
    this.stats.calls += calls.length;
    const res = await fetch(this.#url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(calls.length === 1 ? body[0] : body),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    onStatus(res.status);
    const text = await res.text();
    this.stats.bytes += text.length;
    if (!res.ok) throw new RpcError(calls[0]!.method, res.status, `HTTP ${res.status}: ${text.slice(0, 200)}`);
    const parsed = JSON.parse(text) as Response | Response[];
    const responses = Array.isArray(parsed) ? parsed : [parsed];
    const byId = new Map(responses.map((r) => [r.id, r]));
    return calls.map((c, i) => {
      const r = byId.get(first + i);
      if (r === undefined) throw new RpcError(c.method, -32603, "missing response in batch");
      if (r.error !== undefined) throw new RpcError(c.method, r.error.code, r.error.message, r.error.data);
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
