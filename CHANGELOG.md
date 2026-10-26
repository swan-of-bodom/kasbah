# Changelog

Changes users would notice, newest first. Versions follow semver (README, "License and versions").

## Unreleased

- `address: [a, b, c]`: several addresses for one contract name, sharing its ABI and handlers.
- `endBlock` per contract: nothing after it is fetched or handled.
- `startBlock: "deployment"`: indexes from the block the contract (or its factory) was deployed in, found at startup.
- `filter` per contract: only events whose arguments have the given values (`{ Transfer: { to: "0x…" } }`), typed
  from the ABI. Key arguments are filtered by the node, so only matches are fetched; data arguments after decoding.
- `rpc: loadBalance([...])`: several RPCs, each paced on its own; requests go to the one that can send soonest, then
  the fastest, retries to another. `{ url, maxRequestsPerSecond }` caps one. They must be on the same chain. With
  several, the dashboard shows each one's calls, limit, latency and failures.
- A project's config needs only `rpc` and `contracts`: the tables come from `kasbah.schema.ts`, the database from
  `DATABASE_URL`, the schema from the directory's name, and the API is on (42069). `--schema`, `--port` and
  `--hostname` (`DATABASE_SCHEMA`, `PORT`, `API_HOST`) win over the config. `api: false` turns the API off.
- `network: "mainnet" | "sepolia"` refuses an RPC on another chain, before the schema is touched. `init` writes it.
- `init` no longer writes `schema`, `tables`, `api` or `database`; configs that have them work as before.
- `context.client.readContracts`: several reads in one JSON-RPC batch, shaped like viem's `multicall`.
- `context.client.read` is now `readContract` (and `ReadParameters` is `ReadContractParameters`), as in viem.
- Config defaults are applied in one place (`DEFAULTS` in `src/config/resolve.ts`); behavior is unchanged.
- Config mistakes print as one line, without a stack; other errors print with their cause.
- A `--to` run that reaches its end stores the phase `done`, so `/ready` answers ready.
- `package.json` is no longer part of the build id: reinstalling dependencies doesn't re-index.
- `dev --reset` and `clean`, which new projects run as `pnpm fresh` and `pnpm clean`.
- Every felt handed to handlers and the API is padded to 64 hex digits.
- `event.block` is the full block header with `include.block`; transactions and receipts use the spec's union
  types; `event.log` is the raw event.
- RPC calls are paced per second, and the dashboard shows the rate, throttles and failures.
- bigints in `jsonb` columns are stored as decimal strings.
- New projects use `kasbah.config.ts`, `kasbah.schema.ts`, `src/index.ts` and `src/api/index.ts`.

## 0.1.0

The first version: backfill, head following (polling or WebSocket heads), reorgs, factories, block handlers,
contract reads, transactions and receipts, the raw-event and call cache, the read API (SQL, GraphQL, live queries),
and the CLI (`init`, `dev`, `start`, `serve`, `cache`). Not published.
