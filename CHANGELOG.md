# Changelog

Changes users would notice, newest first. Versions follow semver (README, "License and versions").

## Unreleased

## 0.2.0

Every event now goes through the event cache in Postgres, fetched by a thread of its own; the API is a Hono app with
Ponder's GraphQL; and new projects can start from a template.

### New

- Templates: `pnpm create kasbah --template erc20|ekubo|jediswap|pragma` (or pick one when `init` asks) writes a
  finished mainnet app: LORDS balances, transfers and allowances with GraphQL relations; Ekubo's pools and swaps;
  JediSwap's pairs found through its factory; Pragma's ETH, BTC and STRK prices read every 2,000 blocks.
- `init` (and `pnpm create kasbah`) asks for the directory first, installs the packages and makes the project a git
  repository with one commit. `--skip-install` and `--skip-git` skip those steps, and `--npm`, `--pnpm` and `--yarn`
  pick the package manager (default: the one running `create`), which the project is then written for. The RPC
  defaults to a free public one, with a note in `.env` to replace it for a long backfill.
- The API is a [Hono](https://hono.dev) app: `src/api/index.ts` default-exports one, mounted after kasbah's own
  `/health`, `/ready`, `/status` and `/metrics`. `db` and `graphql()` come from `kasbah/api`:
  `app.use("/graphql", graphql({ db, schema }))`.
- GraphQL is Ponder's: the same schema, filters, ordering, cursors and errors, so a Ponder client or query works as
  is.
- The event cache is always on: every event goes through it, so a re-index fetches nothing again. It costs disk,
  about 400 bytes per event. `cache: { maxCalls }` bounds the cache of contract reads.
- `kasbah --help` lists the commands one line each, and every command has its own help: `kasbah <command> --help` or
  `kasbah help <command>`.
- `kasbah list` shows every app schema in `DATABASE_URL` (running or stopped, made by `dev` or `start`, phase, last
  block, tables, size, last activity) and each event cache's size, then every dev database on the machine with its
  port, size and app directory. `kasbah prune` drops every schema no indexer is running, after asking.
- `pgTable` from `kasbah` names columns in snake_case in Postgres (`sqrtRatio` → `sqrt_ratio`), unless a column names
  itself.
- An enum the ABI declares has its own type in handlers and contract reads: an enum with data is one
  `{ variant, value }` per variant, so checking `variant` narrows `value`.
- A lost database connection no longer ends the run: kasbah retries for about a minute and says so on the screen. A
  commit whose answer was lost is checked with Postgres first, so no batch is written twice or lost.
- The build covers only what decides rows (the contracts and blocks, the chain, the tables, and `src/` except
  `src/api/` and tests): editing an API route or a setting no longer re-indexes.
- API errors: outside `kasbah dev`, an error a route or GraphQL didn't expect reaches the client as a plain 500 and is
  logged; `dev` shows it in full. API queries time out after 30 s and wait at most 500 ms for a lock. A GraphQL
  request runs at most 500 statements, four at a time.
- The progress screen counts every run on the schema, `--debug` shows the fetcher's windows and the RPC's timing, and
  `/metrics` adds heap, GC time, event loop delay and utilization.

### Faster and lighter

- Fetching runs in a thread of its own and writes each page to the event cache as it arrives; handlers read events
  back from it. On Ekubo over Alchemy, block 652k came at 3m08s instead of 4m13s, handlers ran at 37–42k events/s in
  its dense stretch, and the event loop's longest stop stayed near 300 ms. At a 512 MB heap, blocks 620k–630k took
  24 s instead of 293 s. The thread's heap, a quarter of the indexer's, comes on top of it.
- Memory follows the heap Node is given: the row cache is a fifth of it, shared by all tables and counted in bytes.
  The Ekubo template that ran out of a 2 GB heap at block 500k indexes 1.2M blocks in it.
- A table no handler reads (an insert-only one, like swaps or transfers) keeps no rows in memory once they're
  written: cached Ekubo backfills ~16% faster with ~30% less memory.
- Handlers that update the same row again and again (a busy account's balance) no longer slow down as the run goes
  on: a cached LORDS backfill to block 1.3M took 18.5 s instead of 118.8 s.
- Events read back from the cache are unpacked only when a handler reads them: a third less time in GC, a third as
  many event-loop stops over 100 ms, and up to 30% less memory on cached Ekubo backfills.
- Commits no longer stop the backfill: Postgres writes each batch while the next one is handled (4–7% faster on
  Ekubo), and the backfill gives the event loop a turn every 25 ms, so the API keeps answering during it.
- Autovacuum skips an app table while the backfill only inserts into it, and kasbah runs `ANALYZE` when it builds
  the table's key. Commits used to take up to four times longer while autovacuum scanned large tables.
- A restart asks the node only about the blocks since the last one, usually with one `getClassHashAt` call: the
  event cache keeps each contract's class history and each class's ABI. It used to take ~370 calls for Ekubo Core.
- Less CPU per event: building `event` (7% off a cached Ekubo run), escaping COPY text (4%), unpacking felts (2%),
  reading 12,000 events at a time (5%), and encoding them for the cache (20% off a first run).
- An install is 4.5 MB smaller, without `pg-query-emscripten` and `superjson`.

### Fixes

- Ctrl-C during startup stops at once, and a stopped run shows as stopped with the block it committed through.
- `pnpm dev` stopped with Ctrl-C stops its Postgres container too.
- With contracts that start at different blocks, the event cache keeps the blocks fetched just before each later
  start block, so a re-index doesn't fetch them again.
- `kasbah list` and `kasbah prune` leave out a schema that another process drops while they read it.
- A port already in use stops kasbah with a message saying so, instead of leaving it hung.

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
