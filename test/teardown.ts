import pg from "pg";
import { TEST_CHAIN_PREFIX } from "./fixtures/chain.ts";

/** After all tests: drops the event caches of the fake nodes' chains, which each test leaves behind. */
export async function teardown() {
  const url = process.env.DATABASE_URL;
  if (url === undefined) return;
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const { rows } = await pool.query<{ name: string }>(
      `SELECT nspname AS name FROM pg_namespace WHERE starts_with(nspname, $1)`,
      [`kasbah_cache_${TEST_CHAIN_PREFIX}`],
    );
    for (const { name } of rows) await pool.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
  } finally {
    await pool.end();
  }
}
