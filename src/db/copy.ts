import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { is, SQL } from "drizzle-orm";
import type { PoolClient } from "pg";
import { from as copyFrom } from "pg-copy-streams";
import { ConfigError } from "../config/errors.ts";
import { quote } from "../utils/quote.ts";
import { YIELD_MS, yieldToEventLoop } from "../utils/time.ts";
import type { Row, TableInfo } from "./table.ts";

const special = /[\\\n\r\t]/;
/** Most values have nothing to escape: a test is cheaper than a replace that finds nothing. */
const escapeText = (s: string) =>
  special.test(s)
    ? s.replace(/[\\\n\r\t]/g, (c) =>
        c === "\\" ? "\\\\" : c === "\n" ? "\\n" : c === "\r" ? "\\r" : "\\t",
      )
    : s;

function arrayLiteral(values: unknown[]): string {
  const items = values.map((v) => {
    if (v === null || v === undefined) return "NULL";
    if (Array.isArray(v)) return arrayLiteral(v);
    return `"${String(v).replace(/[\\"]/g, (c) => `\\${c}`)}"`;
  });
  return `{${items.join(",")}}`;
}

function text(value: unknown): string {
  if (value === null || value === undefined) return "\\N";
  if (typeof value === "string") return escapeText(value);
  if (typeof value === "number" || typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "t" : "f";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return escapeText(arrayLiteral(value));
  return escapeText(JSON.stringify(value));
}

/** One column of a COPY line: drizzle's driver mapping, then COPY escaping. */
function field(info: TableInfo, row: Row, i: number): string {
  const { key, column } = info.columns[i]!;
  let v = row[key];
  if (v === undefined) {
    if (column.defaultFn !== undefined) v = column.defaultFn();
    else if (column.default !== undefined) {
      if (is(column.default, SQL))
        throw new ConfigError(`${info.name}.${key}: SQL defaults need a value from the handler`);
      v = column.default;
    }
  }
  return text(v === null || v === undefined ? v : column.mapToDriverValue(v));
}

/** One row as a COPY text line. */
export function copyLine(info: TableInfo, row: Row): string {
  let line = field(info, row, 0);
  for (let i = 1; i < info.columns.length; i++) line += `\t${field(info, row, i)}`;
  return `${line}\n`;
}

/**
 * Runs `sql` (a `COPY … FROM STDIN`) with each item's `line`, sent in 64 KB chunks, each joined once from its
 * lines. Building the text never waits on I/O, so it lets the event loop run every `YIELD_MS`: the next batch's
 * handlers go on while a commit writes.
 */
export async function copyLines<T>(
  client: PoolClient,
  sql: string,
  items: Iterable<T>,
  line: (item: T) => string,
): Promise<void> {
  const stream = client.query(copyFrom(sql));
  async function* chunks() {
    let lines: string[] = [];
    let size = 0;
    let since = performance.now();
    for (const item of items) {
      const l = line(item);
      lines.push(l);
      size += l.length;
      if (size > 1 << 16) {
        yield lines.join("");
        lines = [];
        size = 0;
        if (performance.now() - since > YIELD_MS) {
          await yieldToEventLoop();
          since = performance.now();
        }
      }
    }
    if (size > 0) yield lines.join("");
  }
  await pipeline(Readable.from(chunks()), stream);
}

/** Streams rows into `target` (a table or temp table with the same columns) with COPY. */
export function copyRows(
  client: PoolClient,
  info: TableInfo,
  target: string,
  rows: Iterable<Row>,
): Promise<void> {
  const columns = info.columns.map((c) => quote(c.column.name)).join(", ");
  return copyLines(client, `COPY ${target} (${columns}) FROM STDIN`, rows, (row) =>
    copyLine(info, row),
  );
}
