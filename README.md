# kasbah

A minimal, fast Starknet indexer in TypeScript. Design and decisions: [DESIGN.md](DESIGN.md).

## Status

Steps 0–5 of the build order (DESIGN §11), plus what Ponder apps use most: backfill, head following (polling or
WebSocket heads), factories, block handlers, contract reads from handlers, transactions and receipts (opt-in),
the raw-event and call cache, the read API (SQL, GraphQL with relations, live queries) and a CLI with hot reload.

- `src/config/`: `kasbah(config)`, `app.on("Contract:Event", handler)`, `app.run()`, and the `bignum`/`hex` columns.
- `src/types/`: `Block`, `Transaction`, `Receipt` (the spec's shapes) and `felt()`, the one form of a felt.
- `src/abi/`: ABI model, event decoder and types for Cairo 0 and Cairo 1; class history, so each event decodes with
  the class its contract had at that block.
- `src/rpc/`: JSON-RPC client (one or several endpoints, each paced in calls per second; retries, zstd), endpoint probe.
- `src/sync/`: backfill as an ordered event stream with a memory cap (`fetch.ts`), head following with reorg
  detection (`live.ts`), WebSocket new heads (`heads.ts`), transactions and receipts (`extras.ts`).
- `src/indexer/`: one run (`run.ts`): its setup (`open.ts`), the phases (`phases/`: factories, backfill, keys,
  live), the one way it writes (`commit.ts`), fetching events and factory children (`events.ts`), running handlers
  (`handle.ts`); watched addresses, their classes and decoders (`sources.ts`); `context.client`, reads pinned to the block being indexed (`client.ts`); what a
  run reports (`status.ts`: state to read, notices to subscribe to).
- `src/utils/`: small helpers used across the folders (`sleep`, `chunks`, `errorCode`, `secondsSince`).
- `src/db/`: the handler-facing store (in memory, flushed with `COPY`), undo journal for the reorg window, and the
  raw-event, header, transaction and call cache (`cache.ts`).
- `src/api/`: read API: `POST /sql`, `POST /graphql`, `GET /status`, `GET /live` (on in a project, `api: false` turns it off).
- `src/cli/`: the `kasbah` command: `main.ts` parses arguments, `commands/` has one file per command (`init`
  writes a new project from a contract's ABI), `project.ts` finds and loads the app, `devdb.ts` is the dev database,
  `ui/` the terminal screens (progress dashboard, questions).
- `test/unit/` and `test/e2e/` (whole runs against fake nodes, the CLI, the packed package); fixtures in `test/fixtures/`.
- `examples/ekubo/`: Ekubo pools (price, liquidity, balances), hourly and daily candles (OHLC, volume, fees, TVL),
  protocol totals every 1,800 blocks, and routes `/pools/top`, `/pools/:id/candles`, `/history`.

## A new project

```
pnpm create kasbah my-indexer   # once published; until then: node ~/Desktop/kasbah/src/cli/main.ts init my-indexer
kasbah init my-indexer          # the same: asks for the RPC, a contract address (its ABI and deployment block
                                       # are read from the chain), events, timestamps and Postgres (or none); writes
                                       # package.json, .env, the ABI, a table and a handler per event
kasbah init my-indexer --address 0x… --handle Swapped,PositionUpdated --timestamps   # no questions without a terminal or with --yes
cd my-indexer && pnpm install && pnpm dev
pnpm fresh                             # dev, but drops what it stored first and indexes from scratch
pnpm clean                             # deletes what it stored: the dev container and its volume, or with your own
                                       # DATABASE_URL only the app's schema (asks; --yes to skip); the cache stays
```

A project is laid out like Ponder's: `kasbah.config.ts` (`export default kasbah({ … })`: network, RPC,
contracts), `kasbah.schema.ts` (the tables), `abis/<Contract>.ts`, `src/index.ts` (handlers) and `src/api/index.ts`
(routes), both starting with `import app from "../kasbah.config.ts"`, so they're typed from the config without any
code generation.

```ts
export default kasbah({
  network: "mainnet",                         // refuses an RPC on another chain; without it, the RPC's chain
  rpc: process.env.KASBAH_RPC_URL!,
  contracts: { Core: { abi: coreAbi, address: "0x…", startBlock: 165387 } },
  cache: true,
});
```

Several RPCs share the load as in Ponder: each request goes to the one that can take it soonest, the fastest of
those, and a retry goes to another; `maxRequestsPerSecond` caps one (a free tier, say):

```ts
rpc: loadBalance([process.env.ALCHEMY_URL!, { url: process.env.BLAST_URL!, maxRequestsPerSecond: 10 }]),
```

Blocks within `reorgWindow` (64) of the head are indexed with an undo journal, so a reorg can undo them;
`finality: "l1"` makes that "not yet accepted on Ethereum" (`l1_accepted`, a few hours: about 6,000 blocks),
for apps that must never show what a reorg could take back.

What the config leaves out, the project gives: the tables are what `kasbah.schema.ts` exports, the database is
`DATABASE_URL`, the Postgres schema is the directory's name (`my-indexer` → `my_indexer`), and the API is on, at
port 42069. `--schema`/`DATABASE_SCHEMA`, `--port`/`PORT` and `--hostname`/`API_HOST` win over the config, so one
config deploys anywhere (hosts like Railway assign `PORT`); `schema`, `tables`, `database` and `api` in the config
still work, and `api: false` turns the API off. From code (`kasbah()` without the CLI) nothing is implied:
pass `tables`, and `api` to serve it. `kasbah dev|start|serve` with no file runs the project in the working directory; with a file,
a single-file app (`examples/jediswap/index.ts`).

Without `DATABASE_URL`, `dev` runs Postgres in a Docker or Podman container for the app (`docker.io/library/postgres:17`, pulled the
first time; one container and volume per app directory, on a free localhost port), stopped when `dev` exits, data
kept for the next run. `start` never does: it needs `DATABASE_URL`.

It also writes a Dockerfile and a `docker-compose.yml` (Postgres and the indexer, health-checked, the API on
127.0.0.1:42069 for a proxy in front): `docker compose up -d`. From a checkout, the dependency is the packed tarball's path (`pnpm pack` first), which
the image can't install: the Docker build works once kasbah is published.

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

`app.on("setup", ({ context }) => …)` runs once before the first event, on an empty schema (a first run or a
reset), to seed rows; its writes commit with the first blocks, and its `client` reads the state before them.

```
pnpm kasbah dev app.ts       # index, follow the head, restart on every change (a changed build re-indexes);
                             # with `api`, GraphiQL at http://localhost:<port>/graphql in a browser
                             # with a progress screen in a terminal: phase, time left, where the time goes,
                             # handlers by time spent, RPC and cache; --no-ui for plain logs, start --ui for it
                             # --debug adds the fetcher's state, waits and event loop delay
pnpm kasbah start app.ts     # the same without watching; refuses a schema holding another build
pnpm kasbah serve app.ts     # the API alone over what a run stored (a finished --to run, or more API processes)
pnpm kasbah cache info       # each chain's cache and its size; `cache clear [--events] [--calls]`
```

Per contract, `startBlock` is a block number or `"deployment"`: the block the contract (a factory's, for a factory)
was deployed in, found at startup with about 25 `getClassHashAt` calls. `address` is one address or a list of
them sharing the ABI and handlers (`event.address` tells them apart). Optional:
- `endBlock`: the last block indexed for it. Nothing after it is fetched: its events have a request stream of their
  own that stops there.
- `include: { transaction, receipt, block }`: the event's `Transaction`, `Receipt` and block header (`Block`), typed
  only when asked for (one extra call per transaction, or per block with events; cached once final, free for live
  blocks). All follow the spec's shapes in camelCase, amounts as bigints, felts as hex; `Transaction` and `Receipt`
  are unions narrowed by `type`, `version` and `executionStatus`.
- Every event also has `event.log`: its `keys` and `data`, before decoding.
- Every felt handed to handlers and the API (addresses, hashes, selectors, calldata, `event.log`, `client.call`
  results, decoded `ContractAddress`/`ClassHash`) has one form: `0x` and 64 lowercase digits, so `===` compares them.
  `felt(x)` gives that form for your own values. Requests to the node use its form (no leading zeros) inside.
- `upgradeEvents`: events that announce a class replacement, so the class is read again only when one is emitted.
  `Upgraded`, `ClassHashReplaced` and `ImplementationReplaced` are found in the ABI by default; a contract with none
  is checked at every poll, `[]` never.
- `filter`: only events whose arguments have these values, one or a list of allowed ones:
  `filter: { Transfer: { to: "0x…" }, Swapped: { amount: [1n, 2n] } }`. Names and types are checked against the ABI.
  When a filtered argument is a key (`#[key]`), the node does the filtering, so only matches are fetched (those
  events skip the event cache); data arguments are filtered after decoding. Plain values only (felts, integers,
  `u256`, addresses, booleans).

Endpoints of your own, next to `/sql` and `/graphql` (needs `api`):

```ts
app.get("/pools/:key", async ({ db, params, query }) => {
  const pool = await db.query.pools.findFirst({ where: eq(pools.key, params.key!) });  // read-only, typed
  if (pool === undefined) throw new HttpError(404, "no such pool");
  return pool;                        // JSON (bigints as strings); or return a Response for headers and status
});
```

The API limits GraphQL queries to 1,000 tokens, depth 20 and 30 aliases; `GET /health` answers while it and its
database are up, `GET /ready` once it follows the head (or, with
`--to`, once it's done). `GET /metrics` is for Prometheus: checkpoint, head, phase, events and time per handler,
RPC calls per method and per endpoint, reorgs (`kasbah_*`); from `serve`, the stored checkpoint and phase.

The build id covers config, tables, handler code and a hash of the code files in the app's directory (not
`package.json`: reinstalling a dependency doesn't re-index).

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
pnpm install     # also points git at .githooks: a commit Biome would change is refused
pnpm test        # all tests; the Postgres ones need DATABASE_URL in .env
pnpm lint        # Biome: formatting (100 columns), imports, lint rules; CI runs it, with typecheck and test
pnpm lint:fix    # fixes what it can
pnpm kasbah start examples/ekubo/kasbah.config.ts --to 300000   # Ekubo: a project like init writes
# from deployment to block 300,000: 652,647 events, 2.6 min; with timestamps, one header per block with events (79,184)
pnpm typecheck   # includes the type tests (test/*.test-d.ts) on the real ABIs
pnpm fixtures    # refetch test/fixtures from mainnet (needs KASBAH_RPC_URL in .env, see .env.example)
```

A local Postgres for the tests and the example:

```
docker run -d --name kasbah-pg -e POSTGRES_PASSWORD=kasbah -e POSTGRES_DB=kasbah -p 127.0.0.1:5544:5432 docker.io/library/postgres:17
```

Node 24+. Fixtures: Ekubo Core (Cairo 1, flat and nested variants), STRK (OpenZeppelin ERC20, key members), two
Cairo 0 contracts (a pair and an ERC20).

## License and versions

Apache-2.0 (`LICENSE`). Versions follow semver; while at 0.x, a minor version (0.1 → 0.2) may break the config,
the tables it keeps or the API, and a patch never does; `CHANGELOG.md` lists what changed. The package stays `private` until the repo is public.
Contributors and agents: see `AGENTS.md`.
