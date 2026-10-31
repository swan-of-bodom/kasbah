# Changelog

Changes users would notice, newest first. Versions follow semver (README, "License and versions").

## Unreleased

- Memory follows the heap Node is given, so a small machine no longer crashes: the row cache is a fifth of it,
  shared by all tables, the fetch buffer at most another fifth, both counted in bytes. The Ekubo template that ran
  out of a 2 GB heap at block 500k now indexes 1.2M blocks in it.
- A port already in use stops kasbah with a message saying so, instead of leaving it hung.
- Rows `context.db` returns are read-only (and their jsonb values): changing one throws, instead of silently
  changing the cache so it disagrees with Postgres. Use `update` to change a row.
- The backfill gives the event loop a turn every 25 ms, as Ponder does: the API answers during a backfill, and
  the next batch is read while handlers run (5% faster on the Ekubo template).
- A first run with `cache: true` is about 20% faster: raw events are encoded for the cache from their hex text,
  without a BigInt and Buffers per felt.
- `/metrics` reports heap, GC time, event loop delay and utilization, and the fetch buffer.
- The dashboard shows the fetch buffer in MB, and how many workers are idle out of how many.

## 0.1.1

- The npm page links to the docs site, https://swan-of-bodom.github.io/kasbah/.
- `init` from a kasbah checkout says plainly why its project's Docker image won't build until kasbah comes from npm.

## 0.1.0

The first release on npm (`kasbah`, `create-kasbah`).

- Backfill as one ordered event stream from parallel `getEvents` windows, then head following (polling, or
  WebSocket heads), with an undo journal for reorgs, or `finality: "l1"`.
- Cairo 0 and Cairo 1 ABIs, each event decoded with the class its contract had at that block; factories, block
  interval handlers, `filter` on event arguments, `startBlock: "deployment"`, `endBlock`, several addresses per
  contract.
- `context.db` (Drizzle tables, re-exported from `kasbah`), `context.client.readContract` / `readContracts`, and
  transactions, receipts and block headers when a contract asks for them.
- A raw-event and call cache, to re-index without the RPC.
- The read API: `POST /sql`, `POST /graphql` (relations, limits), `GET /live`, your own routes, `/health`, `/ready`,
  `/metrics`.
- Several RPCs with `loadBalance([...])`, each paced in calls per second.
- One indexer per schema (a heartbeat lock), for zero-downtime deploys.
- The CLI: `init` (`pnpm create kasbah`), `dev` with a progress screen, `start`, `serve`, `clean`, `cache`.
