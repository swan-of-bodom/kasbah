# Changelog

Changes users would notice, newest first. Versions follow semver (README, "License and versions").

## Unreleased

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
