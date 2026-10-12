# kasbah

A minimal, fast Starknet indexer in TypeScript. Design and decisions: [DESIGN.md](DESIGN.md).

## Status

Steps 0–5 of the build order (DESIGN §11), plus what Ponder apps use most: backfill, head following (polling or
WebSocket heads), factories, block handlers, contract reads from handlers, transactions and receipts (opt-in),
the raw-event and call cache, the read API (SQL, GraphQL with relations, live queries) and a CLI with hot reload.

- `src/abi/`: ABI model, event decoder and types for Cairo 0 and Cairo 1; class history, so each event decodes with
  the class its contract had at that block.
- `src/rpc/`: JSON-RPC client (adaptive concurrency, retries, zstd), endpoint probe.
- `src/sync/fetch.ts`: backfill as an ordered event stream with a memory cap; `src/sync/live.ts`: head following
  with reorg detection.
- `src/sources.ts`: watched addresses, their classes and decoders, factory children.
- `src/cache.ts`: raw-event cache with coverage per (address, selector), and cached call results.
- `src/client.ts`: `context.client`, contract reads pinned to the block being indexed.
- `src/db/`: the handler-facing store (in memory, flushed with `COPY`), undo journal for the reorg window.
- `src/api/`: read API: `POST /sql`, `POST /graphql`, `GET /status`, `GET /live` (config `api: { port }`).
- `src/sync/heads.ts`: WebSocket new heads; `src/sync/extras.ts`: transactions and receipts.
- `src/cli.ts`: `kasbah init | start | dev | cache`; `src/init.ts`: a new project from a contract's ABI;
  `src/prompt.ts`: the terminal questions.
- `src/app.ts`: `kasbah(config)`, `app.on("Contract:Event", handler)`, `app.run()`; `src/run.ts`: one run, its
  phases and its commits; `src/status.ts`: what it reports (`Status`: state to read, notices to subscribe to).
- `examples/ekubo/`: Ekubo pools (price, liquidity, balances), hourly and daily candles (OHLC, volume, fees, TVL),
  protocol totals every 1,800 blocks, and routes `/pools/top`, `/pools/:id/candles`, `/history`.

## A new project

```
pnpm create kasbah my-indexer   # once published; until then: node ~/Desktop/kasbah/src/cli.ts init my-indexer
kasbah init my-indexer          # the same: asks for the RPC, a contract address (its ABI and deployment block
                                       # are read from the chain), events, timestamps and Postgres (or none); writes
                                       # package.json, .env, the ABI, a table and a handler per event
kasbah init my-indexer --address 0x… --handle Swapped,PositionUpdated --timestamps   # no questions without a terminal or with --yes
cd my-indexer && pnpm install && pnpm dev
```

Without `DATABASE_URL`, `dev` runs Postgres in a Docker or Podman container for the app (`postgres:17`, pulled the
first time; one container and volume per app directory, on a free localhost port), stopped when `dev` exits, data
kept for the next run. `start` never does: it needs `DATABASE_URL`.

It also writes a Dockerfile and a `docker-compose.yml` (Postgres and the indexer, health-checked, the API on
127.0.0.1:42069 for a proxy in front): `docker compose up -d`. From a checkout, the kasbah tarball is copied into
`vendor/` so the image can install it (`pnpm pack` first).

Arguments become columns of their type (`integer`, `bignum`, `hex`, `boolean`, `text`); structs, enums and arrays
`jsonb` (bigints as decimal strings).

## An app

```ts
// app.ts
import { kasbah } from "kasbah";
const app = kasbah({ rpc, database, contracts: { Core: { abi, address, startBlock } }, tables: schema });
app.on("Core:Swapped", async ({ event, context }) => { /* context.db, context.client */ });
export default app;
```

```
pnpm kasbah dev app.ts       # index, follow the head, restart on every change (a changed build re-indexes);
                             # with `api`, GraphiQL at http://localhost:<port>/graphql in a browser
                             # with a progress screen in a terminal: phase, time left, where the time goes,
                             # handlers by time spent, RPC and cache; --no-ui for plain logs, start --ui for it
pnpm kasbah start app.ts     # the same without watching; refuses a schema holding another build
pnpm kasbah serve app.ts     # the API alone over what a run stored (a finished --to run, or more API processes)
pnpm kasbah cache info       # each chain's cache and its size; `cache clear [--events] [--calls]`
```

Per contract, optional:
- `include: { transaction, receipt, block }`: the event's transaction, receipt, and block timestamp, typed only
  when asked for (one extra call per transaction, or per block with events; cached once final, free for live
  blocks' timestamps).
- `upgradeEvents`: events that announce a class replacement, so the class is read again only when one is emitted.
  `Upgraded`, `ClassHashReplaced` and `ImplementationReplaced` are found in the ABI by default; a contract with none
  is checked at every poll, `[]` never.

Endpoints of your own, next to `/sql` and `/graphql` (needs `api`):

```ts
app.get("/pools/:key", async ({ db, params, query }) => {
  const pool = await db.query.pools.findFirst({ where: eq(pools.key, params.key!) });  // read-only, typed
  if (pool === undefined) throw new HttpError(404, "no such pool");
  return pool;                        // JSON (bigints as strings); or return a Response for headers and status
});
```

The API limits GraphQL queries to 1,000 tokens, depth 20 and 30 aliases; `GET /health` answers while it and its
database are up, `GET /ready` once it follows the head.

The build id covers config, tables, handler code and a hash of the code files in the app's directory.
## In another project

Not on a registry (the repo is private): pack it and install the tarball. Node 22.18+ (the app's `.ts` files
run with Node's type stripping; kasbah itself is compiled to `dist/`).

```
cd ~/Desktop/kasbah && pnpm pack                          # builds dist/ and writes kasbah-0.1.0.tgz
cd my-indexer && pnpm add ~/Desktop/kasbah/kasbah-0.1.0.tgz drizzle-orm
pnpm kasbah dev app.ts                                    # reads .env (KASBAH_RPC_URL, DATABASE_URL)
```

`drizzle-orm` is a peer dependency: the app's tables and kasbah's store use the same copy. After a change in
kasbah, pack and `pnpm add` the tarball again. `test/package.test.ts` does all of this outside the repo.

## Commands

```
pnpm install
pnpm test        # all tests; the Postgres ones need DATABASE_URL in .env
node --env-file=.env --no-warnings examples/ekubo/index.ts --port 42070   # Ekubo: backfill, follow the head, serve the API
# from deployment to block 300,000: 652,647 events, 2.6 min; with timestamps, one header per block with events (79,184)
pnpm typecheck   # includes the type tests (test/*.test-d.ts) on the real ABIs
pnpm fixtures    # refetch test/fixtures from mainnet (needs KASBAH_RPC_URL in .env, see .env.example)
```

A local Postgres for the tests and the example:

```
docker run -d --name kasbah-pg -e POSTGRES_PASSWORD=kasbah -e POSTGRES_DB=kasbah -p 127.0.0.1:5544:5432 postgres:17
```

Node 24+. Fixtures: Ekubo Core (Cairo 1, flat and nested variants), STRK (OpenZeppelin ERC20, key members), two
Cairo 0 contracts (a pair and an ERC20).

## License and versions

Apache-2.0 (`LICENSE`). Versions follow semver; while at 0.x, a minor version (0.1 → 0.2) may break the config,
the tables it keeps or the API, and a patch never does. The package stays `private` until the repo is public.
