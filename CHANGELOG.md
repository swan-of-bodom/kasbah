# Changelog

Changes users would notice, newest first. Versions follow semver (README, "License and versions").

## Unreleased

- A first sync fetches in a thread of its own: reading RPC answers and writing them to the event cache no longer
  waits for handlers on the main thread, nor they for it. At a 512 MB heap on blocks 620k–630k, the main thread used
  a third less CPU and its longest stop went from 289 ms to 137 ms (peak RSS 827 → 945 MB: the thread's heap, a
  quarter of the indexer's, comes on top).
- `--debug` shows how long the RPC took to answer, to its headers and with the body read: the gap is time the
  main thread was too busy to read it. `/metrics` reports `endpoint_*` with one endpoint too, no longer only with
  several.
- The raw-event cache is on by default, as Ponder always keeps what it fetched: a re-index fetches nothing again.
  It costs disk, about 400 bytes per event (tens of GB for a busy contract's whole history); `cache: false` turns
  it off.
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
