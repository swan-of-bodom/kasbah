# kasbah

A minimal, fast Starknet indexer in TypeScript. Design and decisions: [DESIGN.md](DESIGN.md).

## Status

Steps 0–5 of the build order (DESIGN §11): backfill, head following, factories, block handlers, the raw-event
cache and the read API.

- `src/abi/`: ABI model, event decoder and types for Cairo 0 and Cairo 1; class history, so each event decodes with
  the class its contract had at that block.
- `src/rpc/`: JSON-RPC client (adaptive concurrency, retries, zstd), endpoint probe.
- `src/sync/fetch.ts`: backfill as an ordered event stream with a memory cap; `src/sync/live.ts`: head following
  with reorg detection.
- `src/sources.ts`: watched addresses, their classes and decoders, factory children.
- `src/cache.ts`: raw-event cache with coverage per (address, selector), and cached call results.
- `src/client.ts`: `context.client`, contract reads pinned to the block being indexed.
- `src/db/`: the handler-facing store (in memory, flushed with `COPY`), undo journal for the reorg window.
- `src/api/`: read API: `POST /sql`, `POST /graphql`, `GET /status` (config `api: { port }`).
- `src/app.ts`: `kasbah(config)`, `app.on("Contract:Event", handler)`, `app.run()`.
- `examples/ekubo/`: Ekubo pools (swap count, volume, price, liquidity).

## Commands

```
pnpm install
pnpm test        # all tests; the Postgres ones need DATABASE_URL in .env
node --env-file=.env --no-warnings examples/ekubo/index.ts --port 42070   # Ekubo pools: backfill, follow the head, serve the API
pnpm typecheck   # includes the type tests (test/*.test-d.ts) on the real ABIs
pnpm fixtures    # refetch test/fixtures from mainnet (needs KASBAH_RPC_URL in .env, see .env.example)
```

A local Postgres for the tests and the example:

```
docker run -d --name kasbah-pg -e POSTGRES_PASSWORD=kasbah -e POSTGRES_DB=kasbah -p 127.0.0.1:5544:5432 postgres:17
```

Node 24+. Fixtures: Ekubo Core (Cairo 1, flat and nested variants), STRK (OpenZeppelin ERC20, key members), two
Cairo 0 contracts (a pair and an ERC20).
