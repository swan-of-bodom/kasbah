/** A Postgres identifier (schema, table, column) quoted for SQL. */
export const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
