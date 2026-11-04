/** A Postgres identifier (schema, table, column) quoted for SQL: in double quotes, each one inside doubled. */
export const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
