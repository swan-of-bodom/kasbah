# kasbah

A minimal, fast Starknet indexer in TypeScript.

Write handlers for your contracts' events, and kasbah stores what they write in Postgres and serves it over SQL,
GraphQL and your own routes. If you've used [Ponder](https://ponder.sh), you already know how it works.

- **Fast backfills**: parallel `getEvents` windows, one ordered stream, writes with `COPY`.
- **Live and reorg-safe**: follows the head, undoes reorgs with a journal, or waits for L1 finality.
- **Starknet-native**: Cairo 0 and Cairo 1 ABIs, decoding with the class a contract had at each block, factories.
- **Typed end to end**: handlers, tables and contract reads are typed from your config, with no code generation.
- **Ready to deploy**: one indexer per schema, `/ready` for zero-downtime deploys, Prometheus metrics.

> [!NOTE]
> kasbah is early (0.x): a minor version may still change the config or the API.

## Quickstart

```bash
pnpm create kasbah my-indexer # asks for an RPC and a contract address, writes the project
cd my-indexer
pnpm install
pnpm dev                      # backfills, follows the head, restarts on every change
```

Then open [localhost:42069/graphql](http://localhost:42069/graphql), or query with SQL:

```bash
curl localhost:42069/sql -d '{"sql": "SELECT * FROM swapped ORDER BY block DESC LIMIT 5"}'
```

## A project

```
my-indexer/
├── kasbah.config.ts    network, RPC, contracts
├── kasbah.schema.ts    your tables
├── abis/               contract ABIs
└── src/
    ├── index.ts        event handlers
    └── api/index.ts    your API routes (optional)
```

```ts
// kasbah.config.ts
export default kasbah({
  network: "mainnet",
  rpc: process.env.KASBAH_RPC_URL!,
  contracts: { Core: { abi: coreAbi, address: "0x…", startBlock: "deployment" } },
});
```

```ts
// kasbah.schema.ts
export const swapped = pgTable("swapped", {
  id: text().primaryKey(),
  block: integer().notNull(),
  locker: hex().notNull(),
});
```

```ts
// src/index.ts
app.on("Core:Swapped", async ({ event, context }) => {
  await context.db.insert(swapped).values({
    id: `${event.transaction.hash}:${event.index}`,
    block: event.block.number,
    locker: event.args.locker,
  });
});
```

## Commands

| Command | What it does |
|---|---|
| `kasbah init <dir>` | a new project from a contract address |
| `kasbah dev` | index and serve, restarting on every change |
| `kasbah start --schema <name>` | index and serve, for production |
| `kasbah serve --schema <name>` | the API alone, over what an indexer stored |
| `kasbah cache info` | the raw-event cache and its size |

## Docs

**[swan-of-bodom.github.io/kasbah](https://swan-of-bodom.github.io/kasbah/)**: configuration, handlers, the API,
and deploying to Railway, Render or a VPS. The source is in [`documentation/`](documentation); the design and its
reasoning are in [DESIGN.md](DESIGN.md).

## From source

Node 22.18+ and pnpm. To use a local checkout instead of the npm package:

```bash
git clone https://github.com/swan-of-bodom/kasbah
cd kasbah && pnpm install
pnpm pack                                     # writes kasbah-<version>.tgz
cd ../my-indexer && pnpm add ../kasbah/kasbah-*.tgz
```

## Development

```bash
pnpm test        # all tests; the Postgres ones need DATABASE_URL in .env
pnpm typecheck
pnpm lint:fix    # Biome; a pre-commit hook refuses unformatted commits
```

A local Postgres for the tests:

```bash
docker run -d --name kasbah-pg -e POSTGRES_PASSWORD=kasbah -e POSTGRES_DB=kasbah \
  -p 127.0.0.1:5544:5432 docker.io/library/postgres:17
```

Contributors and agents: see [AGENTS.md](AGENTS.md).

## Acknowledgments

kasbah's design comes from [Ponder](https://ponder.sh) ([GitHub](https://github.com/ponder-sh/ponder)), the
open-source TypeScript indexer for EVM chains by the Ponder team (MIT). The code here is written for Starknet, but
the project layout, the API and many production choices follow Ponder's, and DESIGN.md notes where. Thank you to
its authors for building it in the open. For EVM chains, use Ponder.

## License

[Apache-2.0](LICENSE). Versions follow semver: while at 0.x, a minor version may break things and a patch never
does. See [CHANGELOG.md](CHANGELOG.md).
