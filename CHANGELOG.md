# Changelog

Changes users would notice, newest first. Versions follow semver (README, "License and versions").

## Unreleased

- **Breaking:** `kasbah` no longer exports its internals `createConfig`, `createDecoder`, `abiEvents`, `abiFunctions`,
  `compileFunction`, `classHistory` and `createHistoricalDecoder`, which the docs never named. `kasbah(config)` takes
  the config as `createConfig` did.
- GraphQL cursors are base64 JSON with tagged bigints and dates, without `superjson`: one dependency fewer. A
  cursor from an earlier version is refused as invalid; ask for the page again.
- **Breaking:** `kasbah cache info` is gone: `kasbah list` shows each chain's cache with its size. `kasbah cache clear`
  stays.
- **Breaking:** `cache: true` is refused, like `cache: false`: the event cache is always on, so it did nothing. Remove it
  from `kasbah.config.ts`; `cache: { maxCalls }` stays. New projects and the templates no longer write it.
- The package no longer depends on `pg-query-emscripten`, which nothing used: an install is 4.5 MB smaller.
- Handlers that update the same row again and again (a busy account's balance) no longer slow down as the run goes
  on. Each update of a hot row took longer than the last, and a cached LORDS backfill to block 1.3M took 118.8 s.
  It now takes 18.5 s.
- `kasbah list` and `kasbah prune` leave out a schema that another process drops while they read it, such as
  during a prune or a reset. They used to fail with "relation does not exist".
- The event cache keeps each contract's class history up to a final block, and each class's ABI. A restart asks
  the node only about the blocks after that, usually with one `getClassHashAt` call. Before, every start asked
  for the whole history again, which took ~370 calls for Ekubo Core.
- Autovacuum now skips an app table while the backfill only inserts into it. kasbah turns it back on, and runs
  `ANALYZE` for fresh statistics, when it builds the table's key: at the end of the backfill, or at the table's
  first update or delete. Before, autovacuum scanned tables of tens of millions of rows during the backfill, and
  commits took up to four times longer for minutes.
- Events read back from the event cache are unpacked only when a handler reads them, not while their batch waits:
  cached Ekubo backfills spend a third less time in GC, pause the event loop for over 100 ms a third as often, use
  up to 30% less memory, and run a few percent faster.
- A table no handler reads (`find`, `update`, `delete`, `onConflictDo…`) keeps no rows in memory once they're
  written: an insert-only table, like swaps or transfers, costs no cache. Cached Ekubo backfills ~16% faster with
  ~30% less memory. A key such a table receives twice is refused at the insert while the first row waits for its
  commit, else when the batch is written, or when its key is built at the end of the backfill.
- `kasbah list` shows, with `DATABASE_URL` (or `--database`), every app schema in that database (without it, in each
  running dev container): running or stopped, made by `dev` or `start`, phase, last block, tables, size and last
  activity, and each event cache's size; then
  every dev database on the machine (the Postgres containers `dev` makes without `DATABASE_URL`): running or
  stopped, port, volume size and the app directory. `dev` now labels the containers it makes with their directory;
  one made before shows none until `kasbah clean` and the next `dev`.
- `pnpm dev` stopped with Ctrl-C now stops its Postgres container: pnpm passes the Ctrl-C on, so `dev` got it twice,
  and the second ended it before it stopped the container, which kept running.
- The progress screen's handler table counts every run on the schema: a run resumed after a stop shows the millions
  its earlier runs handled, not only its own. Each commit saves the totals with its checkpoint. `/metrics` still
  counts the process.
- `kasbah prune` drops every schema in `DATABASE_URL` no indexer is running, after listing them and asking
  (`--yes`), as `ponder db prune` does. The event caches stay.
- The build covers only what decides rows: the config's contracts and blocks, the chain, the tables and the files under
  `src/` except `src/api/` and tests. Editing an API route or a setting (`rpc`, `concurrency`, the port) no longer
  re-indexes in `dev` or refuses `start`. A helper outside `src/` no longer counts; a contract's ABI or `include` now
  does. An app already indexed gets a new build once, when it upgrades.
- API errors: outside `kasbah dev`, an error a route or GraphQL didn't expect reaches the client as a plain 500
  (`Internal Server Error`, or GraphQL's `Unexpected error.`) and is logged; `dev` shows it in full. A request body
  over 1 MB gets a 413. A GraphQL request runs at most 500 statements, four at a time.
- GraphQL: `totalCount` inside a fragment is counted; a `one()` without `fields` takes them from the `one()` back;
  date columns filter and look up by the milliseconds they read back as, or an ISO date; an int8 read as a number is
  a `Float`; a column type of the app's own is `JSON` instead of stopping the app. `replaceBigInts` leaves `Date`s
  and `Buffer`s as they are.
- Templates: `kasbah init --template erc20|ekubo|jediswap` (or `pnpm create kasbah --template …`, or pick one when
  `init` asks what to start from) writes a finished mainnet app: LORDS balances, transfers and allowances with GraphQL
  relations; Ekubo's pools and swaps; JediSwap's pairs found through its factory. They replace `examples/`.
- `init` (and `pnpm create kasbah`) asks for the directory first, installs the packages and makes the project a git
  repository with one commit, as `create-ponder` does: `--skip-install` and `--skip-git` skip them, `--npm`, `--pnpm`
  and `--yarn` pick the package manager (default: the one running `create`), and the project is written for it
  (package.json, Dockerfile, README). `init --help` lists its flags, `-v` prints the version. The RPC defaults to a
  free public one (`https://starknet-rpc.publicnode.com`), with a note in `.env` to replace it for a long backfill.
- **Breaking:** the API is a [Hono](https://hono.dev) app. `src/api/index.ts` default-exports one, and kasbah mounts
  it after its own `/health`, `/ready`, `/status` and `/metrics`. `db` and `graphql()` come from the new `kasbah/api`
  entry: mount GraphQL with `app.use("/graphql", graphql({ db, schema }))`. Gone:
  `app.get`/`app.post` (write Hono routes: `app.get("/x", (c) => c.json(…))`, `HttpError` becomes Hono's
  `HTTPException`), `POST /sql`, `GET /live`, the commit `NOTIFY` and `GET /graphql?query=`. `hono` comes with kasbah; a
  project whose `src/api/index.ts` imports it lists it too (`init` does). `replaceBigInts(value, String)` turns bigints into strings for JSON.
  API queries time out after 30 s (was 10 s) and wait at most 500 ms for a lock. `/health` and `/ready` answer
  with an empty body (`/ready` with "Historical indexing is not complete." before), and `/status` is
  `{ "<chain>": { id, block: { number, timestamp } } }`.
- **Breaking:** `pgTable` from `kasbah` names columns in snake_case in Postgres (`sqrtRatio` → `sqrt_ratio`), unless
  a column names itself; the keys in TypeScript and GraphQL don't change. An app with camelCase keys re-indexes
  once (`dev` does it by itself; `start` asks for `--reset` or a new schema), and its raw SQL uses the new names.
- GraphQL is Ponder's: the same schema, filters, ordering, cursors and errors, so a Ponder client or query works
  as is. This breaks queries written for 0.1: field names come from the table's key as written (`export const pool`
  gives `pool` and `pools`; `pools` would give `pools` and `poolss`), `orderBy` and `orderDirection` are strings
  (`orderBy: "swaps"`), the default page is 50 rows, `pageInfo` adds `hasPreviousPage` and `startCursor`, pages
  take `before` and `offset` and have `totalCount`, strings have `_contains`, `_starts_with`, `_ends_with` and
  `_nocase` filters, arrays `_has`, and `_meta { checkpoint phase }` is now `_meta { status }`, the JSON of
  `GET /status`. A request whose rows would take more than a sixteenth of the API's heap gets an error.

- A lost database connection no longer ends the run: kasbah retries for about a minute, waiting longer each time,
  and says so on the screen ("database connection lost …: retry 3 of 9", then "database: connected again"). A
  Postgres restart, a failover or a network drop used to stop it, and a connection dying while idle could crash
  the process outright. A commit whose COMMIT lost its answer is checked with Postgres before anything is written
  again, so no batch is written twice or lost; if Postgres can't say, the run stops rather than guess.
- The event cache is always on, as every final block's events now go through it: `cache: false` is refused with a
  message saying so (`cache: true` and `cache: { maxCalls }` work as before). Events filtered by key (`filter`)
  are cached too, so a re-index of such an app fetches nothing either, and an existing cache keeps what it has.
  The fetcher's in-memory buffer and its budget are gone; batches read back from the cache are capped in bytes as
  well as in events, so large events stay within a small heap (a 256 MB test). `/metrics`' `fetch_buffer*` gauges
  now count what waits to be written to the cache.
  An existing cache gains a `filter` column the first time this version opens it, and an older version can't
  write to it after that: going back means `kasbah clean` (or dropping its `kasbah_cache_*` schema).
- Reading events back from the cache asks Postgres for about a batch's blocks at a time: a query reaching to
  everything the fetch thread had written took 7.7 s instead of milliseconds, and handling stalled. A stop now ends
  the fetch thread at once. `--debug` shows the read-back queries' slowest time.
- A first sync fetches in a thread of its own: reading RPC answers and writing them to the event cache no longer
  waits for handlers on the main thread, nor they for it. On Ekubo over Alchemy, block 652k came at 3m08s instead
  of 3m56s (main: 4m13s), handlers ran at 37–42k events/s instead of 24–30k in its dense stretch, and the event
  loop's longest stop stayed at about 300 ms (2026-11-03). At a 512 MB heap on blocks 620k–630k, the main thread used
  a third less CPU and its longest stop went from 289 ms to 137 ms (peak RSS 827 → 945 MB: the thread's heap, a
  quarter of the indexer's, comes on top).
- `--debug` shows how long the RPC took to answer, to its headers and with the body read: the gap is time the
  main thread was too busy to read it. `/metrics` reports `endpoint_*` with one endpoint too, no longer only with
  several.
- The raw-event cache is on by default, as Ponder always keeps what it fetched: a re-index fetches nothing again.
  It costs disk, about 400 bytes per event (tens of GB for a busy contract's whole history).
- A first sync writes each fetched page to the event cache as it arrives and handlers read events back from it, as
  Ponder does, so fetching no longer pauses for an in-memory buffer: on Ekubo at a 512 MB heap, blocks 620k–630k
  took 24 s instead of 293 s, with the same rows written (peak RSS 645 → 827 MB). A restart fetches only the
  blocks the cache doesn't have, including those fetched but not yet handled. Commits write only the app's tables.
- A first sync writes its events to the cache for less: COPY goes straight into the cache table, and felts are
  turned into bytes without a regex each. On Ekubo, commits went from 14–17% of the time to 3–5%, and the sync
  reached block 924k 12% sooner.
- Ctrl-C during startup stops at once: it used to wait until every class was read, which takes several seconds on a
  contract with a long history. A stopped run shows as stopped, with the block it committed through, instead of
  `DONE ✓ through block 0`.
- Re-indexing from the cache waits less for events: felts are unpacked without slicing out each one's length
  (on Ekubo, waiting for events 37% shorter, the run about 2% faster).
- Building each handler's `event` costs a third of what it did, 7% off a cached run on Ekubo. `event` is now an
  instance of a class and `event.log` a getter on its prototype, so spreading an event (`{ ...event }`) no
  longer copies `log`.
- Writing rows to Postgres takes less CPU: COPY text is escaped only where a value needs it and each 64 KB chunk
  is joined once (a quarter less time per row on Ekubo's rows, about 4% off a cached run).
- With contracts that start at different blocks, the event cache now keeps everything the first run fetched: the
  blocks fetched just before each later start block were left out, so a re-index fetched them again.
- A backfill no longer stops for its commits: Postgres writes each batch while the next one is handled. On the
  Ekubo template it is 4–7% faster with a 4 GB heap and as fast at 512 MB, with no event-loop stops over 400 ms
  (there were about 20), so the API keeps answering. `kasbah_seconds_total{part="commit"}` and the dashboard's
  commit share now count only the time spent waiting for a commit.
- Memory follows the heap Node is given, so a small machine no longer crashes: the row cache is a fifth of it,
  shared by all tables, the fetch buffer at most another fifth, both counted in bytes. The Ekubo template that ran
  out of a 2 GB heap at block 500k now indexes 1.2M blocks in it.
- A first sync without the cache is about 10% faster on Ekubo: idle workers now help with the window being read
  when the others are paused by the memory budget, instead of waiting (median of 5 interleaved runs to block 700k,
  339 s → 304 s).
- A first sync without the cache is about 5% faster on Ekubo, with 7% less CPU: half the fetch buffer is kept for
  the blocks handled next, instead of filling with blocks far ahead.
- The fetch buffer's memory ceiling now counts pages still downloading, so it holds on a small machine whatever
  the page size or worker count.
- A port already in use stops kasbah with a message saying so, instead of leaving it hung.
- Rows `context.db` returns are read-only (and their jsonb values): changing one throws, instead of silently
  changing the cache so it disagrees with Postgres. Use `update` to change a row.
- The backfill gives the event loop a turn every 25 ms, as Ponder does: the API answers during a backfill, and
  the next batch is read while handlers run (5% faster on the Ekubo template).
- A first run with `cache: true` is about 20% faster: raw events are encoded for the cache from their hex text,
  without a BigInt and Buffers per felt.
- Re-indexing from the cache is about 5% faster: events are read 12,000 at a time instead of 50,000, so fewer are
  alive while handlers run.
- `/metrics` reports heap, GC time, event loop delay and utilization, and the fetch buffer.
- The dashboard shows the fetch buffer in MB, and how many workers are idle out of how many.
- `Status.fetcher`'s `buffered` and `maxBuffered` are now `bufferedBytes` and `maxBufferedBytes`: they count bytes,
  no longer events.

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
