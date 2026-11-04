import type { Reader } from "./reader.ts";

/** What the indexer keeps in `_kasbah_meta` that the API reports. */
export type Meta = { checkpoint?: number; checkpointTime?: number; chain?: string; phase?: string };

/** `GET /status` and GraphQL's `_meta { status }`: per chain, the last block committed; `{}` before the first. */
export type Status = Record<string, { id: string; block: { number: number; timestamp: number } }>;

export async function readMeta(reader: Reader): Promise<Meta> {
  return reader.transaction(async (client) => {
    const { rows } = await client.query<{ key: string; value: unknown }>(
      `SELECT key, value FROM _kasbah_meta WHERE key IN ('checkpoint', 'checkpointTime', 'chain', 'phase')`,
    );
    return Object.fromEntries(rows.map((r) => [r.key, r.value])) as Meta;
  });
}

export async function readStatus(reader: Reader): Promise<Status> {
  const m = await readMeta(reader);
  if (m.chain === undefined || m.checkpoint === undefined) return {};
  return {
    [m.chain]: { id: m.chain, block: { number: m.checkpoint, timestamp: m.checkpointTime ?? 0 } },
  };
}
