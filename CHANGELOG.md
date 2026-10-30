# Changelog

Changes users would notice, newest first. Versions follow semver (README, "License and versions").

## Unreleased

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
