/** The `code` of a Node or Postgres error (`ENOENT`, `23505`, …), if it has one. */
export const errorCode = (e: unknown): string | undefined =>
  typeof (e as { code?: unknown })?.code === "string" ? (e as { code: string }).code : undefined;
