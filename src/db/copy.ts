import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { is, SQL } from "drizzle-orm";
import type { PoolClient } from "pg";
import { from as copyFrom } from "pg-copy-streams";
import { quote, type Row, type TableInfo } from "./table.ts";

const escape = (s: string) => s.replace(/[\\\n\r\t]/g, (c) => (c === "\\" ? "\\\\" : c === "\n" ? "\\n" : c === "\r" ? "\\r" : "\\t"));

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
  if (typeof value === "string") return escape(value);
  if (typeof value === "number" || typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "t" : "f";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return escape(arrayLiteral(value));
  return escape(JSON.stringify(value));
}

/** One row as a COPY text line: drizzle's driver mapping per column, then COPY escaping. */
export function copyLine(info: TableInfo, row: Row): string {
  const fields = info.columns.map(({ key, column }) => {
    let v = row[key];
    if (v === undefined) {
      if (column.defaultFn !== undefined) v = column.defaultFn();
      else if (column.default !== undefined) {
        if (is(column.default, SQL)) throw new Error(`${info.name}.${key}: SQL defaults need a value from the handler`);
        v = column.default;
      }
    }
    return text(v === null || v === undefined ? v : column.mapToDriverValue(v));
  });
  return `${fields.join("\t")}\n`;
}

/** Streams rows into `target` (a table or temp table with the same columns) with COPY. */
export async function copyRows(client: PoolClient, info: TableInfo, target: string, rows: Iterable<Row>) {
  const columns = info.columns.map((c) => quote(c.column.name)).join(", ");
  const stream = client.query(copyFrom(`COPY ${target} (${columns}) FROM STDIN`));
  async function* lines() {
    let chunk = "";
    for (const row of rows) {
      chunk += copyLine(info, row);
      if (chunk.length > 1 << 16) {
        yield chunk;
        chunk = "";
      }
    }
    if (chunk !== "") yield chunk;
  }
  await pipeline(Readable.from(lines()), stream);
}
