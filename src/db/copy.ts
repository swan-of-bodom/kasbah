import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { is, SQL } from "drizzle-orm";
import type { PoolClient } from "pg";
import { from as copyFrom } from "pg-copy-streams";
import { ConfigError } from "../config/errors.ts";
import { YIELD_MS, yieldToEventLoop } from "../utils/time.ts";
import { quote, type Row, type TableInfo } from "./table.ts";

const escapeText = (s: string) =>
  s.replace(/[\\\n\r\t]/g, (c) =>
    c === "\\" ? "\\\\" : c === "\n" ? "\\n" : c === "\r" ? "\\r" : "\\t",
  );

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

/** One row as a COPY text line: drizzle's driver mapping per column, then COPY escaping. */
export function copyLine(info: TableInfo, row: Row): string {
  const fields = info.columns.map(({ key, column }) => {
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
  });
  return `${fields.join("\t")}\n`;
}

/**
 * Runs `sql` (a `COPY … FROM STDIN`) with each item's `line`, built as it's sent in 64 KB chunks. Building the
 * text never waits on I/O, so it lets the event loop run every `YIELD_MS`: the next batch's handlers go on while
 * a commit writes.
 */
export async function copyLines<T>(
  client: PoolClient,
  sql: string,
  items: Iterable<T>,
  line: (item: T) => string,
): Promise<void> {
  const stream = client.query(copyFrom(sql));
  async function* chunks() {
    let chunk = "";
    let since = performance.now();
    for (const item of items) {
      chunk += line(item);
      if (chunk.length > 1 << 16) {
        yield chunk;
        chunk = "";
        if (performance.now() - since > YIELD_MS) {
          await yieldToEventLoop();
          since = performance.now();
        }
      }
    }
    if (chunk !== "") yield chunk;
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
