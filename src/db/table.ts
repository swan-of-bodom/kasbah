import { getTableColumns } from "drizzle-orm";
import { getTableConfig, type PgColumn, type PgTable } from "drizzle-orm/pg-core";
import { ConfigError } from "../config/errors.ts";

export type Row = Record<string, unknown>;

/** What the store needs from a Drizzle table, computed once. */
export type TableInfo = {
  table: PgTable;
  name: string;
  /** Columns in table order, with their JS property keys. */
  columns: { key: string; column: PgColumn }[];
  primaryKey: { key: string; column: PgColumn }[];
  /** Keys of json and jsonb columns. */
  json: string[];
  keyOf: (row: Row) => string;
};

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

export function tableInfo(table: PgTable): TableInfo {
  const config = getTableConfig(table);
  const columns = Object.entries(getTableColumns(table)).map(([key, column]) => ({
    key,
    column: column as PgColumn,
  }));
  const byName = new Map(columns.map((c) => [c.column.name, c]));
  let primaryKey = columns.filter((c) => c.column.primary);
  if (primaryKey.length === 0 && config.primaryKeys[0] !== undefined) {
    primaryKey = config.primaryKeys[0].columns.map((col) => byName.get(col.name)!);
  }
  if (primaryKey.length === 0) throw new ConfigError(`table ${config.name} needs a primary key`);
  const keys = primaryKey.map((c) => c.key);
  const keyOf =
    keys.length === 1
      ? (row: Row) => String(row[keys[0]!])
      : (row: Row) => keys.map((k) => String(row[k])).join("\x1f");
  const json = columns.filter((c) => c.column.dataType === "json").map((c) => c.key);
  return { table, name: config.name, columns, primaryKey, json, keyOf };
}

/** A frozen copy of `v` with every bigint as a decimal string, as jsonb holds it. */
export function frozenJson(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (v === null || typeof v !== "object" || v instanceof Date) return v;
  if (Array.isArray(v)) return Object.freeze(v.map(frozenJson));
  const out: Row = {};
  for (const k in v as Row) out[k] = frozenJson((v as Row)[k]);
  return Object.freeze(out);
}

/**
 * `CREATE TABLE IF NOT EXISTS` for the current `search_path`. Without `primaryKey` the key is left for
 * `primaryKeySql`: tables are filled faster without it.
 */
export function createTableSql(info: TableInfo, { primaryKey = true } = {}): string {
  const keyColumns = new Set(info.primaryKey.map((c) => c.column));
  const cols = info.columns.map(({ column }) => {
    // Key columns are NOT NULL with or without the key, so a missing key part fails at once, not when it's built.
    const notNull = column.notNull || keyColumns.has(column) ? " NOT NULL" : "";
    return `${quote(column.name)} ${column.getSQLType()}${notNull}`;
  });
  if (!primaryKey) return `CREATE TABLE IF NOT EXISTS ${quote(info.name)} (${cols.join(", ")})`;
  const pk = info.primaryKey.map((c) => quote(c.column.name)).join(", ");
  return `CREATE TABLE IF NOT EXISTS ${quote(info.name)} (${cols.join(", ")}, PRIMARY KEY (${pk}))`;
}

/**
 * The index first (readers can still read the table while it builds), then the constraint on it, which locks the
 * table only for a moment.
 */
export function primaryKeySql(info: TableInfo): string[] {
  const name = quote(`${info.name}_pkey`);
  const columns = info.primaryKey.map((c) => quote(c.column.name)).join(", ");
  return [
    `CREATE UNIQUE INDEX IF NOT EXISTS ${name} ON ${quote(info.name)} (${columns})`,
    `ALTER TABLE ${quote(info.name)} ADD CONSTRAINT ${name} PRIMARY KEY USING INDEX ${name}`,
  ];
}

/**
 * `CREATE [UNIQUE] INDEX IF NOT EXISTS` for each Drizzle `index()`/`uniqueIndex()` and unique constraint of the
 * table. Anything kasbah can't create as written (expressions, `where`, ordering, operator classes, foreign keys,
 * checks) is refused here, before indexing starts.
 */
export function indexSql(info: TableInfo): string[] {
  const config = getTableConfig(info.table);
  const refuse = (what: string) => {
    throw new ConfigError(`${info.name}: ${what} are not supported`);
  };
  if (config.foreignKeys.length > 0) refuse("foreign keys");
  if (config.checks.length > 0) refuse("check constraints");
  const out = config.indexes.map(({ config: c }) => {
    const columns = c.columns.map((col) => {
      if (!("name" in col) || typeof col.name !== "string") return refuse("indexes on expressions");
      const o = (col as { indexConfig?: { order?: string; nulls?: string; opClass?: string } })
        .indexConfig;
      if (
        o?.opClass !== undefined ||
        (o?.order !== undefined && o.order !== "asc") ||
        (o?.nulls !== undefined && o.nulls !== "last")
      )
        refuse("index ordering and operator classes");
      return col.name;
    });
    if (c.where !== undefined) refuse("partial indexes");
    if (c.with !== undefined && Object.keys(c.with).length > 0) refuse("index storage options");
    const name = c.name ?? `${info.name}_${columns.join("_")}_index`;
    const using = c.method === undefined || c.method === "btree" ? "" : ` USING ${c.method}`;
    return `CREATE ${c.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${quote(name)} ON ${quote(info.name)}${using} (${columns.map(quote).join(", ")})`;
  });
  const unique = (name: string, columns: string[], nullsNotDistinct: boolean) =>
    `CREATE UNIQUE INDEX IF NOT EXISTS ${quote(name)} ON ${quote(info.name)} (${columns.map(quote).join(", ")})${nullsNotDistinct ? " NULLS NOT DISTINCT" : ""}`;
  for (const u of config.uniqueConstraints) {
    const columns = u.columns.map((c) => c.name);
    out.push(
      unique(u.name ?? `${info.name}_${columns.join("_")}_unique`, columns, u.nullsNotDistinct),
    );
  }
  for (const { column } of info.columns) {
    if (column.isUnique && !column.primary)
      out.push(
        unique(
          column.uniqueName ?? `${info.name}_${column.name}_unique`,
          [column.name],
          column.uniqueType === "not distinct",
        ),
      );
  }
  return out;
}

export { quote };
