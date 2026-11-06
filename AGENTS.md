# Working on kasbah

Rules for anyone changing this repo, people and agents alike. `README.md` maps the folders.

## Before a commit

```
pnpm lint:fix     # Biome: format and lint (the pre-commit hook checks staged files)
pnpm typecheck
pnpm test         # needs DATABASE_URL: a Postgres the tests may create schemas in
```

CI runs the same three on every push to main and on every PR.

- Commits: one short sentence, no trailing period, authored by the person committing, with no tool attribution.
- A change ships with its tests and docs (README, and `CHANGELOG.md` when users would notice it), all
  in the same commit.
- Never commit `.env`, `dist/`, packed `*.tgz` files or RPC URLs with keys, and never print them in logs or issues.

## Code

- Every config default lives in `src/config/resolve.ts` (`DEFAULTS`, `resolveConfig`). The indexer reads the
  resolved config and never writes `config.x ?? n`.
- A limit, size or interval is a named constant with a one-line doc saying why it has that value. Constants that
  tune one mechanism go in one object named for it (`RATE`, `RETRY`, `READ`), with a doc on how the mechanism works
  and one on each field that needs its own reason; a value that stands alone stays a constant of its own.
- Helpers shared across folders go in `src/utils/`, one small file each. Felt forms (`felt`, `unpadded`,
  `canonical`) belong in `src/types/felt.ts`.
- A mistake the user can fix (config, CLI arguments, a missing handler) throws `ConfigError`, which the CLI prints
  without a stack. Anything else is a bug and prints with its stack and cause.
- Only `Position` (`src/indexer/commit.ts`) moves the checkpoint, through `commit()` or, for a backfill batch,
  `start()`. Phases ask for a commit and never write progress themselves.
- No module-level mutable state: a run's state lives on its `Run`, and stopping goes through its `AbortSignal`.
- `templates/` import `kasbah` and `kasbah/api` by name, as a project does: the tsconfig's `paths` and Vitest's
  aliases point them at `src/`, and `test/e2e/package.test.ts` typechecks each one against the packed package.
- Comments: a doc comment on exported API and constants, and inline comments only for what the code cannot say
  (a node's quirk, an ordering that matters). No commented-out code.

## Runs anywhere

kasbah must work on any machine that can start it, from an old laptop to a large server, as Linux does: a smaller
machine, a slower disk or a worse RPC may make it slower, never wrong, stuck or out of memory.

- Limits follow what the process is given (the heap through `heapLimit()`), never a fixed size that assumes a
  machine.
- Nothing grows with the data (block range, event count, windows, rows) without a cap tied to a budget: a long
  history must cost time, not memory.
- Work per step stays small enough that the event loop keeps turning: no pass over a structure that can grow large
  on every page or event.
- A change that touches memory or the fetcher (buffers, caches, budgets, windows) is also run at a small heap
  (`--max-old-space-size=512`) before it is kept; a change to CPU work alone isn't. `test/e2e/crash.test.ts` runs a
  backfill in 192 MB.

## Benchmarks

A performance change is kept only if it beats the noise, measured end to end, as Ponder's `benchmark/` does.

- `pnpm bench:app` runs an app in `test/bench/apps` (Ekubo Core, blocks 620k to 700k by default) on two builds, A
  and B, in pairs A B, then B A: by default HEAD against the working tree; `--a`/`--b` take git revs, `--cache off`
  fetches from the RPC (builds from before 2026-11-03: the cache is always on since, and they refuse it), `--heap 512` checks a small machine, `--node-b=<flags>` gives one side Node or V8 flags
  on the same build, `--env-b "K=V …"` environment variables (`KASBAH_BENCH_CONCURRENCY` sets the app's
  `concurrency`). It stops if Postgres is down, the laptop is on battery or the CPU's turbo is off, and writes
  each run's log and the summary to `test/bench/results` (ignored by git).
- `--rpc sim` fetches from `test/bench/node.ts` instead of the RPC: a simulated node that serves `getEvents` from
  the event cache with hosted Pathfinder's limits after a fixed `--latency`, and replays other calls recorded once
  from the real RPC (`~/.cache/kasbah-bench/rpc-recorded.json`). Use it for fetcher changes: every run then sees the
  same node. Give it a hosted provider's latency, `--latency 700`: Alchemy answered `getEvents` in ~650–900 ms
  (2026-11-02), and at 120 ms a window fetched page after page looked 6× cheaper than it is. It answers its own
  chain id (`SN_BENCH`), so the app's event cache on it is a schema of its own, emptied before every run,
  so every run fetches and writes the cache. The verdict is the median of
  each pair's B/A ratio; pairs whose RPC latency moved over 25% are left out. A run during which the laptop went on
  battery or the CPU's turbo turned off (on this laptop, a low battery) is discarded and stops the benchmark, and
  neither starts one.
- On a CPU with fast and slow cores, kasbah runs pinned to the fastest (`taskset`; `--pin off` to let it float,
  `--pin 4-11` to name the CPUs): a run Linux moved to a slow core used up to ~60% more CPU. Each run also reports
  kasbah's own totals from `/metrics` (in commits, in handlers, waiting for events), its GC time, and its main
  thread's CPU time (the JS, without GC helper threads or waiting on Postgres), so a difference comes with where
  it is.
- Some runs, on either side, are ~12% slower with ~30% more CPU: their young-generation scavenges each take ~35%
  longer (the run's line shows them). Such runs had the same CPU clock and temperature as the others, a full
  battery, and Postgres pinned off kasbah's cores (2026-11-02), and pairs and the median absorb them. They depend
  on where kasbah runs: on this laptop the fastest cores are two P-cores of two hyperthreads each, where 8 of 10
  runs were slow one day (2026-11-02, scavenges 12–19 ms) and fewer GC helper threads (`--v8-pool-size=2`) didn't
  help; pinned to the eight E-cores, which have no hyperthreads (`--pin 4-11`), 1 of 13 was (11–13 ms), with runs
  ~25% longer.
- After each run the runner counts every app table's rows; the summary says if any run wrote different rows than
  the others, so "faster" can't mean "skipped work".
- Ekubo's handlers only insert, so a run can start late: `--from 620000` (the default) keeps 58% of the events to
  block 700k in a ~2.5 min run; `--from 165387` runs its whole history (~4 min), for fetcher changes on sparse
  ranges too.
- It runs 3 pairs, then stops if every pair moved the same way by more than A's own spread (and 1%), or else goes
  on to 5 (`--min-pairs`, `--pairs`). Decide on the median of the pairs and on how many B won; a change inside the
  spread is noise.
- Two ways to keep a run short: at a small heap, which checks memory rather than speed, run a shorter range
  (`--to`, ~10k blocks past `--from`); and when the first pair differs by several times the noise (540 s against
  143 s), stop there and say the verdict rests on one pair.
- Report time, peak memory and event-loop stops together: a change that speeds up one and worsens another is a
  trade-off for the user, not a win.
- `pnpm bench` runs the micro benchmarks in `test/bench/*.bench.ts` (one function on synthetic rows).

## Config compatibility

Apps are written against the config type, so in a patch release:

- new fields are optional, with their default in `DEFAULTS`;
- fields are never renamed or removed;
- a changed default goes in the changelog, since it changes what an existing app does.

At 0.x, a minor version may break any of these (the 0.x note at the top of the README).

## Tests

- `test/unit/`: pure logic, and Postgres when the code under test needs it.
- `test/e2e/`: whole runs against fake nodes (a small HTTP server in each test file), the CLI, and the packed
  package.
- Fakes are written by hand to the real interface, never with module mocking.
- Timing (backoff, pacing, pauses) is tested under fake timers, with the node passed in as `RpcClientOptions.fetch`
  (`test/unit/timing.test.ts`), never by waiting real seconds.
- Recovery from a bad endpoint is tested through `test/e2e/faulty.ts`, a seeded proxy that throttles, fails,
  drops and cuts off a share of requests: the run must end on the same state as the chain.
- Name tests as sentences that state what must hold.
- Never call a paid RPC from tests; recorded ABIs and responses live in `test/fixtures/`.
