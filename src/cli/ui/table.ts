/** A column of `table`: its heading, and right-aligned for numbers. */
export type Column = { title: string; right?: boolean };

/** A row's cells, and how each is colored once padded (`style`: per column index). */
export type Row = { cells: string[]; style?: (column: number, padded: string) => string };

/** The colors `table` and its callers use; plain text when `color` is off. */
export function colors(color: boolean) {
  const c = (open: number, close: number) => (s: string) =>
    color ? `\x1b[${open}m${s}\x1b[${close}m` : s;
  return { dim: c(2, 22), bold: c(1, 22), green: c(32, 39), yellow: c(33, 39) };
}

/**
 * A table in a box like the progress screen's: `kasbah · <title>` and `right` on the top edge, a dim heading, the
 * rows, then `notes` under a blank line. Cells are plain text: their width is their length.
 */
export function table(o: {
  title: string;
  right: string;
  columns: readonly Column[];
  rows: readonly Row[];
  notes?: readonly string[];
  color?: boolean;
}): string[] {
  const { dim, bold } = colors(o.color ?? false);
  const widths = o.columns.map((c, i) =>
    Math.max(c.title.length, ...o.rows.map((r) => (r.cells[i] ?? "").length)),
  );
  const pad = (s: string, i: number) =>
    o.columns[i]?.right ? s.padStart(widths[i] ?? 0) : s.padEnd(widths[i] ?? 0);
  const line = (cells: readonly string[], style = (_i: number, s: string) => s) =>
    o.columns.map((_, i) => style(i, pad(cells[i] ?? "", i))).join("  ");
  const inner = widths.reduce((s, w) => s + w, 0) + 2 * (o.columns.length - 1);
  const notes = o.notes ?? [];
  const title = ` kasbah · ${o.title} `;
  const right = ` ${o.right} `;
  const width = Math.max(inner, ...notes.map((n) => n.length), title.length + right.length + 2);
  // Each line with its visible width, since the colors add characters that take no room.
  const body: [string, number][] = [
    [dim(line(o.columns.map((c) => c.title))), inner],
    ...o.rows.map((r): [string, number] => [line(r.cells, r.style), inner]),
    ...(notes.length === 0
      ? []
      : [["", 0] as [string, number], ...notes.map((n): [string, number] => [n, n.length])]),
  ];
  return [
    `${dim("╭─")} ${bold("kasbah")} ${dim("·")} ${o.title} ${dim("─".repeat(width - title.length - right.length))}${dim(right)}${dim("─╮")}`,
    ...body.map(([s, visible]) => `${dim("│")} ${s}${" ".repeat(width - visible)} ${dim("│")}`),
    dim(`╰${"─".repeat(width + 2)}╯`),
  ];
}

/** A size in decimal units, as Docker and Podman print them. */
export const size = (n: number) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(1)} GB`
    : n >= 1e6
      ? `${Math.round(n / 1e6)} MB`
      : `${Math.round(n / 1e3)} kB`;

/** How long ago `ms` was, roughly: "now" under a minute, then minutes, hours or days. */
export function ago(ms: number, now: number): string {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  const days = Math.floor(s / 86_400);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}
