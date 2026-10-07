import { getTableColumns } from "drizzle-orm";
import { getTableConfig, type PgColumn, type PgTable } from "drizzle-orm/pg-core";

export type Row = Record<string, unknown>;

/** What the store needs from a Drizzle table, computed once. */
export type TableInfo = {
  table: PgTable;
  name: string;
  /** Columns in table order, with their JS property keys. */
  columns: { key: string; column: PgColumn }[];
  primaryKey: { key: string; column: PgColumn }[];
  keyOf: (row: Row) => string;
};

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

export function tableInfo(table: PgTable): TableInfo {
  const config = getTableConfig(table);
  const columns = Object.entries(getTableColumns(table)).map(([key, column]) => ({ key, column: column as PgColumn }));
  const byName = new Map(columns.map((c) => [c.column.name, c]));
  let primaryKey = columns.filter((c) => c.column.primary);
  if (primaryKey.length === 0 && config.primaryKeys[0] !== undefined) {
    primaryKey = config.primaryKeys[0].columns.map((col) => byName.get(col.name)!);
  }
  if (primaryKey.length === 0) throw new Error(`table ${config.name} needs a primary key`);
  const keys = primaryKey.map((c) => c.key);
  const keyOf =
    keys.length === 1
      ? (row: Row) => String(row[keys[0]!])
      : (row: Row) => keys.map((k) => String(row[k])).join("\x1f");
  return { table, name: config.name, columns, primaryKey, keyOf };
}

/**
 * `CREATE TABLE IF NOT EXISTS` for the current `search_path`. Without `primaryKey` the key is left for
 * `primaryKeySql`: tables are filled faster without it.
 */
export function createTableSql(info: TableInfo, { primaryKey = true } = {}): string {
  const cols = info.columns.map(({ column }) => {
    const notNull = column.notNull || column.primary ? " NOT NULL" : "";
    return `${quote(column.name)} ${column.getSQLType()}${notNull}`;
  });
  if (!primaryKey) return `CREATE TABLE IF NOT EXISTS ${quote(info.name)} (${cols.join(", ")})`;
  const pk = info.primaryKey.map((c) => quote(c.column.name)).join(", ");
  return `CREATE TABLE IF NOT EXISTS ${quote(info.name)} (${cols.join(", ")}, PRIMARY KEY (${pk}))`;
}

export function primaryKeySql(info: TableInfo): string {
  return `ALTER TABLE ${quote(info.name)} ADD PRIMARY KEY (${info.primaryKey.map((c) => quote(c.column.name)).join(", ")})`;
}

/** `CREATE [UNIQUE] INDEX IF NOT EXISTS` for each Drizzle `index()`/`uniqueIndex()` of the table (columns only). */
export function indexSql(info: TableInfo): string[] {
  return getTableConfig(info.table).indexes.map(({ config }) => {
    const columns = config.columns.map((c) => {
      if (!("name" in c) || typeof c.name !== "string") throw new Error(`${info.name}: indexes on expressions are not supported`);
      return c.name;
    });
    if (config.where !== undefined) throw new Error(`${info.name}: partial indexes are not supported`);
    const name = config.name ?? `${info.name}_${columns.join("_")}_index`;
    const using = config.method === undefined || config.method === "btree" ? "" : ` USING ${config.method}`;
    return `CREATE ${config.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${quote(name)} ON ${quote(info.name)}${using} (${columns.map(quote).join(", ")})`;
  });
}

export { quote };
