import type { Note } from "../status.ts";

export type SocketNote = Extract<Note, { kind: "socket" }>;

/** A `starknet_subscribeNewHeads` WebSocket that only says "a block arrived". Reconnects with backoff, forever. */
export class HeadSubscription {
  /** Connected and subscribed. */
  healthy = false;
  readonly stats = { heads: 0, connects: 0 };
  /** The newest head announced, and when it arrived (ms since the epoch). */
  last: { number: number; timestamp: number; at: number } | undefined;
  readonly #url: string;
  readonly #note: (n: SocketNote) => void;
  #socket: WebSocket | undefined;
  #closed = false;
  #arrived = false;
  #waiters: (() => void)[] = [];
  #backoff = 500;

  /** Notes "on" at once, then "refused" (with the node's reason), "reconnected" and "closed" as they happen. */
  constructor(url: string, note: (n: SocketNote) => void) {
    this.#url = url;
    this.#note = note;
    note({ kind: "socket", state: "on" });
    this.#connect();
  }

  /**
   * Resolves on the next head (at once if one arrived since the last call), after `ms`, or on abort. The caller
   * passes a long `ms` while `healthy` and its polling interval otherwise.
   */
  wait(ms: number, signal: AbortSignal): Promise<void> {
    if (this.#arrived || signal.aborted) {
      this.#arrived = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        signal.removeEventListener("abort", done);
        this.#waiters = this.#waiters.filter((w) => w !== done);
        this.#arrived = false;
        resolve();
      };
      const t = setTimeout(done, ms);
      signal.addEventListener("abort", done);
      this.#waiters.push(done);
    });
  }

  close() {
    this.#closed = true;
    this.#socket?.close();
    for (const w of [...this.#waiters]) w();
  }

  #wake() {
    this.stats.heads++;
    this.#arrived = true;
    for (const w of [...this.#waiters]) w();
  }

  #connect() {
    if (this.#closed) return;
    const ws = new WebSocket(this.#url);
    this.#socket = ws;
    let subscription: string | undefined;
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "starknet_subscribeNewHeads", params: {} }));
    ws.onmessage = (m) => {
      let msg: { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: { subscription_id?: string; result?: { block_number?: number; timestamp?: number } } };
      try {
        msg = JSON.parse(String(m.data));
      } catch {
        return;
      }
      if (msg.id === 1) {
        if (msg.error !== undefined || typeof msg.result !== "string") {
          this.#note({ kind: "socket", state: "refused", reason: msg.error?.message ?? "no subscription id" });
          this.#closed = true;
          ws.close();
          return;
        }
        subscription = msg.result;
        this.healthy = true;
        this.stats.connects++;
        this.#backoff = 500;
        if (this.stats.connects > 1) this.#note({ kind: "socket", state: "reconnected" });
        // A head may have been missed while disconnected: check now.
        this.#wake();
        return;
      }
      // New heads and reorg notices both mean "look again"; the follower checks hashes either way.
      if (msg.method?.startsWith("starknet_subscription") && (subscription === undefined || msg.params?.subscription_id === undefined || msg.params.subscription_id === subscription)) {
        const h = msg.params?.result;
        if (typeof h?.block_number === "number" && typeof h.timestamp === "number" && h.block_number > (this.last?.number ?? -1)) this.last = { number: h.block_number, timestamp: h.timestamp, at: Date.now() };
        this.#wake();
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      const was = this.healthy;
      this.healthy = false;
      if (this.#closed) return;
      if (was) this.#note({ kind: "socket", state: "closed" });
      setTimeout(() => this.#connect(), this.#backoff);
      this.#backoff = Math.min(this.#backoff * 2, 30_000);
    };
  }
}
