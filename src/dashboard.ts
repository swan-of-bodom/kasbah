import { format } from "node:util";
import type { Status } from "./status.ts";

const thousands = (n: number) => Math.round(n).toLocaleString("en-US");

const compact = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}k` : thousands(n);

const bytes = (n: number) => (n >= 2 ** 30 ? `${(n / 2 ** 30).toFixed(1)} GB` : `${Math.round(n / 2 ** 20)} MB`);

export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

const micros = (ms: number) => (ms >= 1 ? `${ms.toFixed(1)} ms` : `${Math.round(ms * 1000)} µs`);

function bar(fraction: number, width: number): string {
  const f = Math.min(1, Math.max(0, fraction));
  const full = Math.floor(f * width);
  const part = " ▏▎▍▌▋▊▉"[Math.floor((f * width - full) * 8)] ?? "";
  return `${"█".repeat(full)}${full < width ? part : ""}`.padEnd(width, "·");
}

const LABEL = 10;
const row = (label: string, text: string) => `${label.padEnd(LABEL)}${text}`;

/** The dev screen's lines for `status`, without colors. */
export function render(status: Status, now = performance.now()): string[] {
  const lines: string[] = [];
  const up = duration((now - status.started) / 1000);
  const where = [status.schema, status.endpoint, status.tip > 0 ? `tip ${thousands(status.tip)}` : ""].filter(Boolean).join(" · ");
  lines.push(row("kasbah", `${where}   up ${up} · ${bytes(process.memoryUsage().rss)}`));
  const watched = status.children > 0 ? `${thousands(status.contracts)} contracts, ${thousands(status.children)} from ${status.factories} ${status.factories === 1 ? "factory" : "factories"}` : `${thousands(status.contracts)} contracts`;
  if (status.contracts > 0) lines.push(row("", watched));

  const r = status.range;
  const inPhase = (now - status.phaseStarted) / 1000;
  const progressLines = (label: string) => {
    const span = Math.max(1, r.to - r.first + 1);
    const fraction = (r.through - r.first + 1) / span;
    const pace = status.pace(now);
    const left = pace.left === undefined ? "estimating…" : `~${duration(pace.left)} left`;
    lines.push(row(label, `${bar(fraction, 24)} ${(fraction * 100).toFixed(1).padStart(5)}%  block ${thousands(r.through)} / ${thousands(r.to)}  ${left}`));
    if (label === "backfill") lines.push(row("", `${compact(pace.events)} events/s now · ${compact(status.handled)} handled · ${duration(inPhase)} so far`));
  };
  switch (status.phase) {
    case "starting":
      lines.push(row("starting", "reading classes and checking the chain…"));
      break;
    case "factories":
      progressLines("factories");
      break;
    case "backfill":
      progressLines("backfill");
      break;
    case "keys":
      lines.push(row("keys", `building ${status.keys.tables} primary keys and ${status.keys.indexes} indexes… ${duration(inPhase)}`));
      break;
    case "live": {
      const l = status.live;
      const behind = l.timestamp > 0 ? `${(Date.now() / 1000 - l.timestamp).toFixed(1)}s behind its timestamp` : "waiting for a block";
      const last = l.at > 0 ? ` · last block ${duration((Date.now() - l.at) / 1000)} ago, ${l.events} events` : "";
      lines.push(row("live", `block ${thousands(l.block)} · ${behind}${last} · ${l.reorgs} ${l.reorgs === 1 ? "reorg" : "reorgs"}`));
      break;
    }
    case "done":
      lines.push(row("done", `through block ${thousands(r.through)} · ${compact(status.handled)} handled in ${up}`));
      break;
  }

  const t = status.time;
  const total = t.fetch + t.handlers + t.commit;
  if (total > 1000 && status.phase !== "live") {
    const share = (x: number) => `${Math.round((x / total) * 100)}%`;
    const top = Math.max(t.fetch, t.handlers, t.commit);
    const bound = top / total < 0.5 ? "" : top === t.fetch ? " · bound by fetching (RPC or cache)" : top === t.handlers ? " · bound by handlers" : " · bound by commits (database)";
    lines.push(row("time", `waiting for events ${share(t.fetch)} · handlers ${share(t.handlers)} · commits ${share(t.commit)}${bound}`));
  }
  if (status.lastCommit.ms > 0) {
    const c = status.lastCommit;
    const parts = c.tables > 0 || c.cache > 0 ? ` (tables ${micros(c.tables)}${status.cache === undefined ? "" : `, cache ${micros(c.cache)}`})` : "";
    lines.push(row("commit", `last ${micros(c.ms)}${parts}`));
  }

  const handlers = [...status.handlers].sort((a, b) => b[1].ms - a[1].ms);
  if (handlers.length > 0) {
    const width = Math.min(32, Math.max(...handlers.map(([n]) => n.length)));
    const spent = handlers.reduce((s, [, h]) => s + h.ms, 0) || 1;
    for (const [i, [name, h]] of handlers.slice(0, 6).entries()) {
      const n = name.length > width ? `${name.slice(0, width - 1)}…` : name.padEnd(width);
      lines.push(row(i === 0 ? "handlers" : "", `${n}  ${compact(h.count).padStart(7)}  ${micros(h.ms / h.count).padStart(8)} avg  ${String(Math.round((h.ms / spent) * 100)).padStart(3)}%`));
    }
    if (handlers.length > 6) lines.push(row("", `+${handlers.length - 6} more`));
  }

  if (status.rpc !== undefined) {
    const s = status.rpc;
    const trouble = [s.retries > 0 ? `${thousands(s.retries)} retries` : "", s.throttled > 0 ? `${thousands(s.throttled)} throttled` : ""].filter(Boolean).join(" · ");
    lines.push(row("rpc", `${thousands(s.requests)} requests, ${thousands(s.calls)} calls · ${bytes(s.bytes)} in · concurrency ${status.concurrency()}${trouble === "" ? "" : ` · ${trouble}`}`));
  }
  if (status.cache !== undefined && status.cache.cachedEvents + status.cache.fetchedEvents > 0) {
    lines.push(row("cache", `${compact(status.cache.cachedEvents)} events from the cache, ${compact(status.cache.fetchedEvents)} fetched`));
  }
  if (status.calls !== undefined && status.calls.calls + status.calls.cached > 0) {
    lines.push(row("reads", `${thousands(status.calls.calls + status.calls.cached)} contract reads, ${thousands(status.calls.cached)} cached`));
  }
  if (status.api !== "") lines.push(row("api", `${status.api}  (POST /sql, /graphql · GET /live, /status)`));
  return lines;
}

/**
 * Draws `status` under the log, redrawn in place: log lines (and anything the app prints) scroll above it and
 * stay in the terminal's history.
 */
export class Screen {
  readonly #status: Status;
  readonly #out: NodeJS.WriteStream;
  readonly #write: typeof process.stdout.write;
  #drawn = 0;
  #timer: NodeJS.Timeout | undefined;
  readonly #console: Pick<Console, "log" | "info" | "warn" | "error">;

  constructor(status: Status, out: NodeJS.WriteStream = process.stdout) {
    this.#status = status;
    this.#out = out;
    this.#write = out.write.bind(out) as typeof process.stdout.write;
    this.#console = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  }

  /** Prints a line above the screen. */
  readonly log = (line: string) => this.#print(`[kasbah] ${line}`);

  start() {
    // Handlers' own console output goes above the screen too, instead of through it.
    for (const k of ["log", "info", "warn", "error"] as const) console[k] = (...args: unknown[]) => this.#print(format(...args));
    this.#timer = setInterval(() => this.#draw(""), 250);
    this.#timer.unref();
    this.#draw("");
  }

  /** Draws the last state and leaves it in place. */
  stop() {
    clearInterval(this.#timer);
    this.#draw("");
    this.#drawn = 0;
    Object.assign(console, this.#console);
  }

  #print(text: string) {
    this.#draw(`${text}\n`);
  }

  #draw(above: string) {
    const width = Math.max(40, (this.#out.columns ?? 100) - 1);
    const lines = render(this.#status).map((l) => {
      const cut = l.length > width ? `${l.slice(0, width - 1)}…` : l;
      return `\x1b[2m${cut.slice(0, LABEL)}\x1b[22m${cut.slice(LABEL)}`;
    });
    const clear = this.#drawn > 0 ? `\x1b[${this.#drawn}F\x1b[J` : "";
    this.#write(`${clear}${above}${lines.join("\n")}\n`);
    this.#drawn = lines.length;
  }
}
