<h1 align="center">kasbah</h1>

<p align="center">A minimal, fast Starknet indexer in TypeScript.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/kasbah"><img src="https://img.shields.io/npm/v/kasbah" alt="npm version"></a>
  <a href="https://github.com/swan-of-bodom/kasbah/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/swan-of-bodom/kasbah/ci.yml?branch=main&label=CI" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Apache-2.0"></a>
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="#performance">Performance</a> ·
  <a href="https://swan-of-bodom.github.io/kasbah/">Docs</a>
</p>

<br>

Write handlers for your contracts' events, and kasbah stores what they write in Postgres and serves it over SQL,
GraphQL and your own endpoints. If you've used [Ponder](https://ponder.sh), you already know how it works.

- **Fast backfills**: parallel `getEvents` windows, one ordered stream, writes with `COPY`.
- **Live and reorg-safe**: follows the head and undoes reorgs with a journal, or waits for L1 finality.
- **Starknet-native**: Cairo 0 and 1 ABIs, factories, and the class a contract had at each block.
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

> [!TIP]
> Open [localhost:42069/graphql](http://localhost:42069/graphql) for GraphiQL.

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
import { kasbah } from "kasbah";
import coreAbi from "./abis/Core.ts";

export default kasbah({
  network: "mainnet",
  rpc: process.env.KASBAH_RPC_URL!,
  contracts: { Core: { abi: coreAbi, address: "0x…", startBlock: "deployment" } },
});
```

```ts
// kasbah.schema.ts
import { hex, integer, pgTable, text } from "kasbah";

export const swapped = pgTable("swapped", {
  id: text().primaryKey(),
  block: integer().notNull(),
  locker: hex().notNull(),
});
```

```ts
// src/index.ts
import app from "../kasbah.config.ts";
import { swapped } from "../kasbah.schema.ts";

app.on("Core:Swapped", async ({ event, context }) => {
  await context.db.insert(swapped).values({
    id: `${event.transaction.hash}:${event.index}`,
    block: event.block.number,
    locker: event.args.locker,
  });
});
```

```ts
// src/api/index.ts
import { Hono } from "hono";
import { desc } from "kasbah";
import { db, graphql } from "kasbah/api";
import * as schema from "../../kasbah.schema.ts";

const app = new Hono();

app.use("/graphql", graphql({ db, schema }));

app.get("/swaps/latest", async (c) => {
  const rows = await db.select().from(schema.swapped).orderBy(desc(schema.swapped.block)).limit(20);
  return c.json(rows);
});

export default app;
```

## Use kasbah

Start a project with `pnpm create kasbah` (recommended), then run `pnpm kasbah <command>`:

| Command | What it does                                          |
| ------- | ----------------------------------------------------- |
| `init`  | Create a project from a contract address or a template |
| `dev`   | Index and serve, restarting on every file change      |
| `start` | Index and serve, for production                       |
| `serve` | Serve the API alone, over what an indexer stored      |
| `clean` | Delete what the app stored                            |
| `list`  | Show the app schemas, event caches and dev databases  |
| `prune` | Drop the schemas no indexer is running                |
| `cache` | Empty the raw-event and call caches                   |

`kasbah <command> --help` prints a command's options, and the
[CLI reference](https://swan-of-bodom.github.io/kasbah/docs/reference/cli) has every flag.

## Performance

Full history of a template, from its start block to the chain head, on a cold event cache, with Alchemy as the RPC
and Postgres 17 on the same machine. Measured on a laptop (Intel Core i7, 10 cores) with kasbah 0.2.2 on Node 22,
in November 2026, one run per template.

| Template | Indexes                       | Blocks | Events |    Time |
| -------- | ----------------------------- | -----: | -----: | ------: |
| `erc20`  | LORDS transfers and approvals |  17.5M |   2.5M |  ~45 s  |
| `ekubo`  | swaps and pool creation       |  17.4M |  42.9M | ~16 min |

To measure your own, run `pnpm create kasbah --template ekubo` and `pnpm dev`.

## Docs

Configuration, handlers, the API and deploying to production are covered at
**[swan-of-bodom.github.io/kasbah](https://swan-of-bodom.github.io/kasbah/)**.

## Contributing

If you're interested in contributing to kasbah, please read the [contribution guide](.github/CONTRIBUTING.md).

## Acknowledgments

kasbah's design, API and many production choices follow [Ponder](https://github.com/ponder-sh/ponder) (MIT), the
TypeScript indexer for EVM chains. How this repo is organized follows
[rindexer](https://github.com/joshstevens19/rindexer) (MIT): one folder per concern, every config default in one
file, limits as named constants. Thank you to both. For EVM chains, use Ponder or rindexer.

## License

Apache-2.0, with code adapted from MIT projects listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
