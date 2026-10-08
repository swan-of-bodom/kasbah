import { format } from "node:util";
import type { Phase, Status } from "./status.ts";

const thousands = (n: number) => Math.round(n).toLocaleString("en-US");

const compact = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}k` : thousands(n);

const bytes = (n: number) => (n >= 2 ** 30 ? `${(n / 2 ** 30).toFixed(1)} GB` : `${Math.round(n / 2 ** 20)} MB`);

const plural = (n: number, one: string, many = `${one}s`) => `${thousands(n)} ${n === 1 ? one : many}`;

export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

const micros = (ms: number) => (ms >= 1 ? `${ms.toFixed(1)} ms` : `${Math.round(ms * 1000)} µs`);

const ESC = /\x1b\[[0-9;]*m/g;
const visible = (s: string) => s.replace(ESC, "").length;

/** Cuts `s` to `width` visible characters, keeping its color codes. */
function fit(s: string, width: number): string {
  if (visible(s) <= width) return s;
  let out = "";
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\x1b") {
      const end = s.indexOf("m", i);
      out += s.slice(i, end + 1);
      i = end;
    } else if (n < width - 1) {
      out += s[i];
      n++;
    }
  }
  return s.includes("\x1b") ? `${out}…\x1b[0m` : `${out}…`;
}

type Paint = Record<"dim" | "bold" | "cyan" | "green" | "yellow" | "blue" | "magenta" | "red", (s: string) => string> & { badge: (phase: Phase) => string };

function paint(on: boolean): Paint {
  const c = (open: number, close: number) => (s: string) => (on ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  const colors: Record<Phase, number> = { starting: 100, factories: 45, backfill: 43, keys: 45, live: 42, done: 44 };
  return {
    dim: c(2, 22),
    bold: c(1, 22),
    cyan: c(36, 39),
    green: c(32, 39),
    yellow: c(33, 39),
    blue: c(34, 39),
    magenta: c(35, 39),
    red: c(31, 39),
    badge: (phase) => (on ? `\x1b[30;${colors[phase]};1m ${phase.toUpperCase()} \x1b[0m` : `[${phase.toUpperCase()}]`),
  };
}

function bar(fraction: number, width: number, p: Paint): string {
  const f = Math.min(1, Math.max(0, fraction));
  const full = Math.floor(f * width);
  const part = full < width ? (" ▏▎▍▌▋▊▉"[Math.floor((f * width - full) * 8)] ?? "").trim() : "";
  return p.green("█".repeat(full) + part) + p.dim("░".repeat(width - full - part.length));
}

function sparkline(values: readonly number[], width: number): string {
  const v = values.slice(-width);
  const max = Math.max(...v, 1);
  return v.map((x) => "▁▂▃▄▅▆▇█"[Math.min(7, Math.floor((x / max) * 7.999))]).join("");
}

export type RenderOptions = { width?: number; color?: boolean; now?: number };

/** The dev screen: a box of lines for `status`, `width` columns wide. */
export function render(status: Status, { width = 100, color = false, now = performance.now() }: RenderOptions = {}): string[] {
  const p = paint(color);
  const inner = Math.max(40, width - 4);
  const body: string[] = [];
  const line = (s = "") => body.push(s);
  /** `left` and `right` on one line, `right` flush right. */
  const split = (left: string, right: string) => line(`${left}${" ".repeat(Math.max(1, inner - visible(left) - visible(right)))}${right}`);
  const label = (name: string, text: string) => line(`${p.dim(name.padEnd(9))}${text}`);

  const where = [status.endpoint, status.tip > 0 ? `tip ${thousands(status.tip)}` : "", status.contracts > 0 ? plural(status.contracts, "contract") : ""];
  if (status.children > 0) where.push(`${thousands(status.children)} from ${plural(status.factories, "factory", "factories")}`);
  split(p.dim(where.filter(Boolean).join(" · ")), p.dim(`up ${duration((now - status.started) / 1000)} · ${bytes(process.memoryUsage().rss)}`));
  line();

  const r = status.range;
  const inPhase = (now - status.phaseStarted) / 1000;
  const pace = status.pace(now);
  const rate = (label_: string) => {
    if (status.history.length < 2) return;
    const spark = sparkline(status.history, Math.min(40, inner - 30));
    label(label_, `${p.bold(compact(pace.events).padStart(6))}  ${p.cyan(spark)}  ${p.dim("last 2 min")}`);
  };
  switch (status.phase) {
    case "starting":
      line(p.dim("reading classes and checking the chain…"));
      break;
    case "factories":
    case "backfill": {
      const fraction = (r.through - r.first + 1) / Math.max(1, r.to - r.first + 1);
      const pct = `${(fraction * 100).toFixed(1)}%`.padStart(6);
      line(`${bar(fraction, inner - 8, p)}  ${p.bold(pct)}`);
      let left = p.dim("estimating…");
      if (pace.range !== undefined && pace.range[1] > pace.range[0] * 1.5) left = `${duration(pace.range[0])} – ${duration(pace.range[1])} left ${p.dim("(varies with event density)")}`;
      else if (pace.left !== undefined) left = `~${duration(pace.left)} left`;
      split(`block ${p.bold(thousands(r.through))} / ${thousands(r.to)}${status.phase === "factories" ? p.dim("  finding factory children") : ""}`, left);
      line();
      rate("events/s");
      label("handled", `${p.bold(compact(status.handled))} in ${duration(inPhase)}`);
      break;
    }
    case "keys":
      line(`building ${plural(status.keys.tables, "primary key")} and ${plural(status.keys.indexes, "index", "indexes")}… ${duration(inPhase)}`);
      break;
    case "live": {
      const l = status.live;
      const behind = l.timestamp > 0 ? `${p.bold(`${(Date.now() / 1000 - l.timestamp).toFixed(1)}s`)} behind the chain` : p.dim("waiting for a block");
      split(`block ${p.bold(thousands(l.block))} · ${behind}`, l.at > 0 ? p.dim(`last block ${duration((Date.now() - l.at) / 1000)} ago, ${plural(l.events, "event")}`) : "");
      label("reorgs", l.reorgs === 0 ? p.dim("none") : p.yellow(thousands(l.reorgs)));
      rate("events/s");
      break;
    }
    case "done":
      line(`${p.green("✓")} through block ${p.bold(thousands(r.through))} · ${compact(status.handled)} handled in ${duration((now - status.started) / 1000)}`);
      break;
  }

  const t = status.time;
  const total = t.fetch + t.handlers + t.commit;
  if (total > 1000 && status.phase !== "live" && status.phase !== "starting") {
    line();
    const w = 30;
    const seg = (x: number) => Math.round((x / total) * w);
    const [f, h] = [seg(t.fetch), seg(t.handlers)];
    const c = Math.max(0, w - f - h);
    const share = (x: number) => `${Math.round((x / total) * 100)}%`;
    label("time", `${p.blue("█".repeat(f))}${p.magenta("█".repeat(h))}${p.yellow("█".repeat(c))}  ${p.blue("■")} fetch ${share(t.fetch)}  ${p.magenta("■")} handlers ${share(t.handlers)}  ${p.yellow("■")} commits ${share(t.commit)}`);
    const top = Math.max(t.fetch, t.handlers, t.commit);
    const bound = top / total < 0.5 ? "no single bottleneck" : top === t.fetch ? "bound by fetching (RPC or cache)" : top === t.handlers ? "bound by handlers" : "bound by commits (database)";
    const commit = status.lastCommit.ms > 0 ? ` · last commit ${micros(status.lastCommit.ms)}${status.lastCommit.tables > 0 ? ` (tables ${micros(status.lastCommit.tables)})` : ""}` : "";
    label("", p.dim(`${bound}${commit}`));
  }

  const handlers = [...status.handlers].sort((a, b) => b[1].ms - a[1].ms);
  if (handlers.length > 0) {
    line();
    const nameWidth = Math.min(32, Math.max(7, ...handlers.map(([n]) => n.length)));
    const spent = handlers.reduce((s, [, h]) => s + h.ms, 0) || 1;
    line(p.dim(`${"HANDLER".padEnd(nameWidth)}  ${"EVENTS".padStart(8)}  ${"AVG".padStart(8)}  ${"TIME".padStart(5)}`));
    for (const [name, h] of handlers.slice(0, 6)) {
      const n = name.length > nameWidth ? `${name.slice(0, nameWidth - 1)}…` : name.padEnd(nameWidth);
      const share = h.ms / spent;
      line(`${n}  ${compact(h.count).padStart(8)}  ${micros(h.ms / h.count).padStart(8)}  ${`${Math.round(share * 100)}%`.padStart(5)}  ${p.magenta("▇".repeat(Math.round(share * 12)))}`);
    }
    if (handlers.length > 6) line(p.dim(`+${handlers.length - 6} more`));
  }

  line();
  if (status.rpc !== undefined) {
    const s = status.rpc;
    const trouble = [s.retries > 0 ? p.yellow(`${thousands(s.retries)} retries`) : "", s.throttled > 0 ? p.yellow(`${thousands(s.throttled)} throttled`) : ""].filter(Boolean);
    label("rpc", [`${thousands(s.requests)} requests`, `${thousands(s.calls)} calls`, `${bytes(s.bytes)} in`, `concurrency ${status.concurrency()}`, ...trouble].join(p.dim(" · ")));
  }
  if (status.cache !== undefined && status.cache.cachedEvents + status.cache.fetchedEvents > 0) {
    label("cache", `${compact(status.cache.cachedEvents)} events from the cache · ${compact(status.cache.fetchedEvents)} fetched`);
  }
  if (status.calls !== undefined && status.calls.calls + status.calls.cached > 0) {
    label("reads", `${thousands(status.calls.calls + status.calls.cached)} contract reads · ${thousands(status.calls.cached)} cached`);
  }
  if (status.api !== "") label("api", `${p.cyan(`${status.api}/graphql`)}  ${p.dim("GraphiQL in a browser · POST /sql · GET /live /status")}`);

  const title = ` ${p.bold("kasbah")}${status.schema === "" ? "" : ` ${p.dim("·")} ${status.schema}`} `;
  const badge = ` ${p.badge(status.phase)} `;
  const top = `${p.dim("╭─")}${title}${p.dim("─".repeat(Math.max(1, inner + 2 - 1 - visible(title) - visible(badge) - 1)))}${badge}${p.dim("─╮")}`;
  const rows = body.map((b) => {
    const s = fit(b, inner);
    return `${p.dim("│")} ${s}${" ".repeat(inner - visible(s))} ${p.dim("│")}`;
  });
  return [top, ...rows, p.dim(`╰${"─".repeat(inner + 2)}╯`)];
}

/**
 * Draws `status` under the log, redrawn in place: log lines (and anything the app prints) scroll above it and
 * stay in the terminal's history.
 */
export class Screen {
  readonly #status: Status;
  readonly #out: NodeJS.WriteStream;
  readonly #write: typeof process.stdout.write;
  readonly #color: boolean;
  #drawn = 0;
  #timer: NodeJS.Timeout | undefined;
  readonly #console: Pick<Console, "log" | "info" | "warn" | "error">;

  constructor(status: Status, out: NodeJS.WriteStream = process.stdout) {
    this.#status = status;
    this.#out = out;
    this.#write = out.write.bind(out) as typeof process.stdout.write;
    this.#color = out.isTTY === true && process.env.NO_COLOR === undefined;
    this.#console = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  }

  /** Prints a line above the screen. */
  readonly log = (line: string) => this.#print(`${this.#color ? "\x1b[2m[kasbah]\x1b[22m" : "[kasbah]"} ${line}`);

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
    const width = Math.min(110, Math.max(44, (this.#out.columns ?? 100) - 1));
    const lines = render(this.#status, { width, color: this.#color });
    const clear = this.#drawn > 0 ? `\x1b[${this.#drawn}F\x1b[J` : "";
    this.#write(`${clear}${above}${lines.join("\n")}\n`);
    this.#drawn = lines.length;
  }
}
