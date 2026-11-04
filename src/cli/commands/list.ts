import { homedir } from "node:os";
import { type DevDatabaseInfo, listDevDatabases } from "../devdb.ts";

/** `kasbah list`: every dev database on the machine, largest first, in a box like the progress screen's. */
export function list() {
  const found = listDevDatabases();
  const color = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
  if (found === undefined) return void console.log("no Docker or Podman: no dev databases");
  console.log(renderList(found.databases, found.runtime, { color, home: homedir() }).join("\n"));
}

/** A size in decimal units, as Docker and Podman print them. */
const size = (n: number) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(1)} GB`
    : n >= 1e6
      ? `${Math.round(n / 1e6)} MB`
      : `${Math.round(n / 1e3)} kB`;

/** The table `kasbah list` prints, without color when `color` is off. */
export function renderList(
  databases: readonly DevDatabaseInfo[],
  runtime: string,
  { color = false, home = "" }: { color?: boolean; home?: string } = {},
): string[] {
  const c = (open: number, close: number) => (s: string) =>
    color ? `\x1b[${open}m${s}\x1b[${close}m` : s;
  const dim = c(2, 22);
  const bold = c(1, 22);
  const green = c(32, 39);
  if (databases.length === 0)
    return [
      `no dev databases (${runtime}): \`kasbah dev\` makes one for an app without DATABASE_URL`,
    ];

  const shortHome = (dir: string) =>
    home !== "" && (dir === home || dir.startsWith(`${home}/`))
      ? `~${dir.slice(home.length)}`
      : dir;
  const rows = databases.map((d) => ({
    container: d.container,
    state: d.running ? "running" : "stopped",
    port: d.port ?? "-",
    size: d.bytes === undefined ? "?" : size(d.bytes),
    app: d.app === undefined ? "-" : shortHome(d.app),
    running: d.running,
  }));
  const head = { container: "CONTAINER", state: "STATE", port: "PORT", size: "SIZE", app: "APP" };
  const w = (k: keyof typeof head) => Math.max(head[k].length, ...rows.map((r) => r[k].length));
  const widths = {
    container: w("container"),
    state: w("state"),
    port: w("port"),
    size: w("size"),
    app: w("app"),
  };
  const cells = (r: typeof head, paint = (_k: keyof typeof head, s: string) => s) =>
    [
      paint("container", r.container.padEnd(widths.container)),
      paint("state", r.state.padEnd(widths.state)),
      paint("port", r.port.padStart(widths.port)),
      paint("size", r.size.padStart(widths.size)),
      paint("app", r.app.padEnd(widths.app)),
    ].join("  ");
  const inner = Object.values(widths).reduce((s, x) => s + x, 0) + 2 * 4;

  const total = databases.reduce((s, d) => s + (d.bytes ?? 0), 0);
  const running = databases.filter((d) => d.running).length;
  const summary = `${databases.length} ${databases.length === 1 ? "database" : "databases"} · ${running} running · ${size(total)}`;
  const title = ` ${bold("kasbah")} ${dim("·")} dev databases `;
  const titleWidth = ` kasbah · dev databases `.length;
  const right = ` ${runtime} `;
  // Each line with its visible width: the cells are padded to `inner`, the summary isn't.
  const body: [string, number][] = [
    [dim(cells(head)), inner],
    ...rows.map((r): [string, number] => [
      cells(r, (k, s) =>
        k === "state" ? (r.running ? green(s) : dim(s)) : k === "app" && r.app === "-" ? dim(s) : s,
      ),
      inner,
    ]),
    ["", 0],
    [summary, summary.length],
  ];
  const width = Math.max(inner, titleWidth + right.length + 2);
  return [
    `${dim("╭─")}${title}${dim("─".repeat(width + 2 - 1 - titleWidth - right.length - 1))}${dim(right)}${dim("─╮")}`,
    ...body.map(([s, visible]) => `${dim("│")} ${s}${" ".repeat(width - visible)} ${dim("│")}`),
    dim(`╰${"─".repeat(width + 2)}╯`),
    dim("delete one with `kasbah clean` in its app directory"),
  ];
}
