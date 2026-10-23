# Working on kasbah

Rules for anyone changing this repo, people and agents alike. `README.md` maps the folders and `DESIGN.md` gives
the reasons behind them.

## Before a commit

```
pnpm lint:fix     # Biome: format and lint (the pre-commit hook checks staged files)
pnpm typecheck
pnpm test         # needs DATABASE_URL: a Postgres the tests may create schemas in
```

CI runs the same three on every push to main and on every PR.

- Commits: one short sentence, no trailing period, authored by the person committing, with no tool attribution.
- A change ships with its tests and docs (README, DESIGN, and `CHANGELOG.md` when users would notice it), all
  in the same commit.
- Never commit `.env`, `dist/`, packed `*.tgz` files or RPC URLs with keys, and never print them in logs or issues.

## Code

- Every config default lives in `src/config/resolve.ts` (`DEFAULTS`, `resolveConfig`). The indexer reads the
  resolved config and never writes `config.x ?? n`.
- A limit, size or interval is a named constant with a one-line doc saying why it has that value.
- Helpers shared across folders go in `src/utils/`, one small file each. Felt forms (`felt`, `unpadded`,
  `canonical`) belong in `src/types/felt.ts`.
- A mistake the user can fix (config, CLI arguments, a missing handler) throws `ConfigError`, which the CLI prints
  without a stack. Anything else is a bug and prints with its stack and cause.
- Only `Position.commit()` (`src/indexer/commit.ts`) moves the checkpoint. Phases ask for a commit and never
  write progress themselves.
- No module-level mutable state: a run's state lives on its `Run`, and stopping goes through its `AbortSignal`.
- Comments: a doc comment on exported API and constants, and inline comments only for what the code cannot say
  (a node's quirk, an ordering that matters). No commented-out code.

## Config compatibility

Apps are written against the config type, so in a patch release:

- new fields are optional, with their default in `DEFAULTS`;
- fields are never renamed or removed;
- a changed default goes in the changelog, since it changes what an existing app does.

At 0.x, a minor version may break any of these (README, "License and versions").

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
