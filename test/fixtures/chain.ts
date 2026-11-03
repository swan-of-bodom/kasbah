import { randomBytes } from "node:crypto";

/** What every test chain id starts with: `test/teardown.ts` drops their event caches (`kasbah_cache_0x7e57…`). */
export const TEST_CHAIN_PREFIX = "0x7e57";

/**
 * A chain id of its own for a fake node: the event cache is always on, and two fake chains under one id would read
 * each other's cached events, in parallel test files too.
 */
export const testChain = () => `${TEST_CHAIN_PREFIX}${randomBytes(6).toString("hex")}`;
