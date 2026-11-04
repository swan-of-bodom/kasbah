/** The channel the indexer notifies on each commit, with a JSON array of the tables it wrote, or `null`. */
export const liveChannel = (schema: string) => `kasbah_${schema}`;

/**
 * NOTIFY payloads over this many bytes say `null` (any table) instead of the list: Postgres refuses payloads of
 * 8,000 bytes or more.
 */
export const MAX_NOTIFY_BYTES = 7_000;

/** What a commit that wrote `tables` (all of them: `undefined`) notifies. */
export function livePayload(tables: string[] | undefined): string {
  const payload = JSON.stringify(tables ?? null);
  return Buffer.byteLength(payload) > MAX_NOTIFY_BYTES ? "null" : payload;
}

/** The tables a payload names, `_kasbah_meta` added; `undefined` for any table. */
export function liveTables(payload: string): string[] | undefined {
  try {
    const tables = JSON.parse(payload) as unknown;
    if (Array.isArray(tables) && tables.every((t) => typeof t === "string"))
      return [...tables, "_kasbah_meta"];
  } catch {}
  return undefined;
}
