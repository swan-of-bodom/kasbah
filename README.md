# kasbah

A minimal, fast Starknet indexer in TypeScript.

Write handlers for your contracts' events, and kasbah stores what they write in Postgres and serves it over SQL,
GraphQL and your own endpoints. If you've used [Ponder](https://ponder.sh), you already know how it works.

- **Fast backfills**: parallel `getEvents` windows, one ordered stream, writes with `COPY`.
- **Live and reorg-safe**: follows the head, undoes reorgs with a journal, or waits for L1 finality.
- **Starknet-native**: Cairo 0 and Cairo 1 ABIs, decoding with the class a contract had at each block, factories.
- **Typed end to end**: handlers, tables and contract reads are typed from your config, with no code generation.
- **Ready to deploy**: one indexer per schema, `/ready` for zero-downtime deploys, Prometheus metrics.

> [!NOTE]
> kasbah is early (0.x): a minor version may still change the config or the API.

## Quickstart

You need Node 22.18 or later, a package manager (pnpm, npm or Yarn), and either Docker or Podman (`pnpm dev` then
runs Postgres in a container) or a Postgres of your own, set as `DATABASE_URL` in `.env`.

```bash
pnpm create kasbah my-indexer # asks for a contract or a template, an RPC and Postgres; installs it
cd my-indexer
pnpm dev                      # backfills, follows the head, restarts on every change
```

Or start from a template: `pnpm create kasbah --template erc20` (LORDS, with GraphQL relations), `ekubo` (pools
and swaps), `jediswap` (pairs found through the factory) or `pragma` (oracle prices read every 2,000 blocks).

Then open [localhost:42069/graphql](http://localhost:42069/graphql) for GraphiQL, or ask from anywhere:

```bash
curl localhost:42069/graphql -H 'content-type: application/json' \
  -d '{"query": "{ swappeds(orderBy: \"block\", orderDirection: \"desc\", limit: 5) { items { id block } } }"}'
```

## A project

```
my-indexer/
├── kasbah.config.ts    network, RPC, contracts
├── kasbah.schema.ts    your tables
├── abis/               contract ABIs
└── src/
    ├── index.ts        event handlers
    └── api/index.ts    the HTTP API: a Hono app with GraphQL and your endpoints
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

## Use kasbah

Start a project with `pnpm create kasbah` (recommended): it needs nothing installed beforehand and takes the same
flags as `kasbah init` (`pnpm create kasbah --help`). `npm create kasbah` and `yarn create kasbah` work too, and the
project then uses npm or Yarn. In a project, the `dev`, `fresh`, `clean`, `start` and `serve` scripts (`pnpm dev`,
`npm run dev`) run the commands below.

Once installed, run `kasbah --help` in your project (`pnpm kasbah --help`, `npx kasbah --help`) to see every
command:

```bash
pnpm kasbah --help
```

```
A minimal, fast Starknet indexer in TypeScript.

Usage: kasbah <command> [options]

Commands:
  init   Create a project from a contract address or a template
  dev    Index and serve, restarting on every file change
  start  Index and serve, for production
  serve  Serve the API alone, over what an indexer stored
  clean  Delete what the app stored
  list   Show the app schemas, event caches and dev databases
  prune  Drop the schemas no indexer is running
  cache  Empty the raw-event and call caches
  help   Print this, or a command's help (kasbah help <command>)

Options:
  -h, --help     Print help (kasbah <command> --help for a command's options)
  -v, --version  Print the version

Reads .env from the working directory. Docs: https://swan-of-bodom.github.io/kasbah/
```

`kasbah <command> --help` (or `kasbah help <command>`) prints a command's options, and the
[CLI reference](https://swan-of-bodom.github.io/kasbah/docs/reference/cli) has every flag.

## Docs

**[swan-of-bodom.github.io/kasbah](https://swan-of-bodom.github.io/kasbah/)**: configuration, handlers, the API,
and deploying to Railway, Render or a VPS. The source is in [`documentation/`](documentation). To work on kasbah
itself, see [CONTRIBUTING.md](.github/CONTRIBUTING.md).

## Acknowledgments

kasbah's design comes from [Ponder](https://ponder.sh) ([GitHub](https://github.com/ponder-sh/ponder)), the
open-source TypeScript indexer for EVM chains by the Ponder team (MIT). The code here is written for Starknet, but
the project layout, the API and many production choices follow Ponder's. Thank you to its authors for building it
in the open.

How this repo is organized follows [rindexer](https://rindexer.xyz)
([GitHub](https://github.com/joshstevens19/rindexer)), the Rust indexer for EVM chains (MIT): one folder per concern,
every config default in one file, limits as named constants, and the rules in AGENTS.md. Thank you to its authors
too. For EVM chains, use Ponder or rindexer.

## License

[Apache-2.0](LICENSE), with code adapted from MIT projects listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Versions follow semver: while at 0.x, a minor version may break things and a patch never
does. See [CHANGELOG.md](CHANGELOG.md).
