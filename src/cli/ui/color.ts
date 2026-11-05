/** Wraps text in a terminal color, or returns it as is. */
export type Color = (s: string) => string;

/** Whether to color what goes to `out`: a terminal, unless `NO_COLOR` is set. */
export const wantsColor = (out: { isTTY?: boolean }): boolean =>
  out.isTTY === true && process.env.NO_COLOR === undefined;

/** The colors the CLI uses; each returns the text unchanged when `on` is false. */
export function colors(on: boolean) {
  const c =
    (open: number, close: number): Color =>
    (s) =>
      on ? `\x1b[${open}m${s}\x1b[${close}m` : s;
  return {
    dim: c(2, 22),
    bold: c(1, 22),
    red: c(31, 39),
    green: c(32, 39),
    yellow: c(33, 39),
    blue: c(34, 39),
    magenta: c(35, 39),
    cyan: c(36, 39),
  };
}
