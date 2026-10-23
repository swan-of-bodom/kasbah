# kasbah: design (draft 2)

kasbah is a Starknet-only indexer in TypeScript. Users declare contracts (fixed addresses or factory children) and event
handlers that write to Postgres; the indexer backfills history, follows the chain head, and serves the tables.

Goal: the smallest and fastest indexer possible, built on what Starknet's RPC gives us instead of on EVM
workarounds. Not a Ponder fork. We copy Ponder's good ideas (listed in §9) and drop its EVM machinery.

Sources for every fact below: Ponder 0.18.3 source (main), the Starknet spec v0.10.4, Pathfinder /
Juno / Madara source (HEAD), provider docs, and live probes. Appendix A has the numbers.

---

## 1. What Starknet changes

| EVM (what Ponder is built around) | Starknet (what we build around) |
|---|---|
| `eth_getLogs` errors on "range too large"; Ponder parses provider error strings to guess ranges | `starknet_getEvents` pages server-side: `chunk_size` + `continuation_token`; no range errors |
| One address or small arrays; Ponder chunks by 50 | `address` takes an array (spec 0.10.1+); 5,000 addresses accepted in one call |
| `logIndex` per block, no tx position needed | Events carry `transaction_index` + `event_index` (per tx); identity = `(block, tx_index, event_index)` |
| Logs bloom in the header; client-side skipping | No bloom in headers; the **node** skips blocks with per-block blooms aggregated over 8,192 blocks |
| Finality guessed from timestamps (Ponder: 180 s window) | Explicit: block `status` and tx `finality_status` ∈ PRE_CONFIRMED / ACCEPTED_ON_L2 / ACCEPTED_ON_L1, plus the `l1_accepted` tag |
| Reorgs common; deep reorg buffer | ACCEPTED_ON_L2 is final under L2 consensus (spec wording); reorgs are a defense-in-depth case |
| After logs, fetch block + txs (+ receipts) per block | Events need only a block header (timestamp, hash); txs/receipts only if a handler asks |
| Factories found only by events | Also by `getStateUpdate.deployed_contracts` (address + class hash), even when the factory emits nothing |
| `eth_call` returns bytes, `0x` before deploy | `starknet_call` returns `FELT[]`, errors with code 20 before deploy |

## 2. Scope

**v1:**
- One Starknet chain per process (mainnet or sepolia). No multichain ordering. That alone removes about a third
  of Ponder's runtime (omnichain/multichain/isolated merge logic).
- Event handlers on contracts given by address or by factory (event-based discovery).
- Block-interval handlers ("every N blocks").
- Cairo 0 and Cairo 1 contracts (§8).
- Postgres only. Tables declared with Drizzle (like Ponder's `onchainTable`).
- Read API: SQL over HTTP (read-only, like `@ponder/client`) and GraphQL generated from the schema.
- First test target: Ekubo pools on mainnet (Core contract; Ekubo events carry everything in `data`, a single
  selector key, see `test/fixtures/`).

**Later, opt-in:** pre-confirmed overlay (§6.3), class-hash factories (§5.3), call/trace handlers
(`traceBlockTransactions`), WebSocket live mode (§6.2), storage-diff handlers (`getStateUpdate`).

**Never:** EVM support, bloom filters, provider error-string parsing, Multicall3 splitting, trace/transfer filters
in core, the `ponder dev` drop-everything mode.

## 3. Architecture

```
            ┌──────────────── endpoint layer (§4) ─────────────────┐
            │ capability probe · calls/s pacing · pinning          │
            └───────▲───────────────────▲──────────────────▲───────┘
                    │                   │                  │
   ┌────────────────┴──┐   ┌────────────┴─────┐   ┌────────┴────────┐
   │ factory pre-pass  │──▶│ backfill fetcher │   │ live follower   │
   │ (§5.2)            │   │ windows ∥ (§5)   │   │ poll / ws (§6)  │
   └───────────────────┘   └────────┬─────────┘   └────────┬────────┘
                                    │ ordered event batches │
                                    ▼                       ▼
                         ┌───────────────────────────────────────┐
                         │ decoder (Cairo ABI, precompiled §8)   │
                         └──────────────────┬────────────────────┘
                                            ▼
                         ┌───────────────────────────────────────┐
                         │ indexing: handlers → in-memory store  │
                         │ flush: COPY per batch / per block (§7)│
                         └──────────────────┬────────────────────┘
                                            ▼
                Postgres: user tables · undo journal · raw-event cache · checkpoint
```

One process, three stages connected by bounded queues: fetch → decode → index. Fetching runs ahead of indexing up
to a memory cap (not unbounded into the database, as Ponder does).

**On a first run, events go straight from fetch to handlers in memory.** The raw events are written to the cache
on the side (COPY, not awaited by indexing). Ponder instead writes everything to its sync store and reads it back
before indexing; we skip that round trip.

## 4. Endpoint layer

**Startup probe**, per endpoint (a few calls, cached per process):
- `starknet_specVersion`: require 0.10.x (needed for address arrays); refuse older.
- Node type: `pathfinder_version` / `juno_version`.
- Page cap: `chunk_size` 1025 and 10241 (error 31 above the cap). Pathfinder 1024, Juno 10240, Madara 1000.
- Block-scan cap: Pathfinder returns at most 81,920 blocks per call; Juno unlimited by default.
- Batch limit: Pathfinder 100, Juno 1000. Pathfinder runs batch items **one at a time**, so parallelism comes from
  parallel HTTP requests, not batches.
- WS compliance (only if a WS URL is configured): address array in `subscribeEvents`, `event_index` present,
  backfill honored. Alchemy fails all three today; PublicNode (Juno) and self-hosted nodes pass.

**Request policy:**
- Every request names an explicit block number or hash. Never `latest` in a data call: behind a load balancer
  (Alchemy), consecutive calls can see different heads.
- Pacing per endpoint in calls per second, each call in a batch counted (providers rate and bill per call), after
  Ponder's `rpc/index.ts` (unchanged through 0.18.3): doubles until the first 429, which halves it, then +5% per 5 s of
  successes while rate-bound, −5% and a pause (100 ms ×1.5 per 429 in a row, ≤5 s) per 429. Concurrency alone
  couldn't do it: at 1 request in flight, one batch of 100 header calls still went over Alchemy's limit (130 retries
  in 1,030 requests); paced, Ekubo 310k–315k took 6,232 calls with 0 throttled. Later: several endpoints with
  latency-based routing, as Ponder does.
- **Continuation tokens are node-specific** (`"<block>-<n>"`, but `n` counts matched events on Pathfinder and raw
  events on Juno). A pagination chain stays on one endpoint. If the endpoint changes, restart from the token's
  block number with no token and drop duplicates by `(block, tx_index, event_index)`.

## 5. Backfill

### 5.1 Event fetch

- **One filter for everything:** all watched addresses in one `address` array, the union of handled event
  selectors at key position 0 (`keys: [[sel1, sel2, …]]`). One request covers every contract at once.
- **Windows aligned to 8,192 blocks** (the nodes' bloom aggregate size), at most 81,920 blocks (Pathfinder's scan
  cap). Windows run in parallel; inside a window, follow the token sequentially.
- **An empty page with a token means "keep going"**, not "done" (Pathfinder's scan cap).
- Window size adapts to density: busy contracts get smaller windows so pages don't serialize a whole window;
  quiet contracts get 81,920-block windows that come back in one call.
- **Very large address sets** (more than ~1,000 children): split the array across parallel requests. Above a
  threshold where the selector alone is rarer than the address set, query by selector only and filter addresses
  client-side (Ponder's `factoryAddressCountThreshold` idea, decided per filter by measured density).

### 5.2 Factories: a pre-pass, not interleaving

Factory contracts are usually quiet, so one `getEvents` on the factory address scans 81,920 blocks per call.
**Discover all children over the whole history first**, then fetch child events with the full address list, each
child bounded by its creation block. Ponder interleaves factory and child fetching per interval, and marks every
later interval missing if any factory interval is missing; the pre-pass removes all of that.

During live following, a new child is added at its block, and child events from that same block are fetched in
the same step.

Built (`src/indexer/sources.ts`, config `factory: { address, abi, event, parameter }`):
- Pre-pass over the factory's events up to the backfill end; children stored in `_kasbah_children` with their
  creation block, and `discovered:<contract>` in `_kasbah_meta`, so a restart only scans what's new.
- A child's classes: probed at its creation block and at the tip, bisected only if they differ (2 calls per child
  instead of a full history). Children with the same class share one decoder.
- Live: each tick first reads the factory's events for the tick's blocks, adds the children, then fetches child
  events with them included. A reorg forgets children created after the ancestor (memory and table).
- Class checks while live: children of a contract with upgrade events need none (§6.1); otherwise up to 100
  addresses, one batched `getClassHashAt` per tick; above, each block's `getStateUpdate` and its
  `replaced_classes` (one call per block, whatever the number of contracts).
- Address lists are not split. Measured on Alchemy, `getEvents` over 10k blocks with N addresses:
  1k → 96 ms, 10k (237 KB body) → 356 ms, 50k (1.2 MB) → 1.3 s, all accepted. The stream already fetches block
  windows in parallel, so splitting would add a merge for nothing. Revisit only for a node that caps the list.

### 5.3 Class-hash factories (later)

`getStateUpdate(block).state_diff.deployed_contracts` lists every deployment with its class hash, including
`deploy_syscall`s that emit no event. But it is one call per block, with no range query. That is cheap live
(one call per block) and too expensive for full history (17M calls). Historical discovery would need the
Universal Deployer's `ContractDeployed` event (covers UDC deployments only) or a known start block.

### 5.4 Block headers

`getEvents` results have no timestamp. Measured on Ekubo (§11.1), **headers cost about 100× more RPC than the
events themselves**: one `getBlockWithTxHashes` per block with events (there is no header-only HTTP method), versus
one `getEvents` per 1,024–10,240 events. So headers are opt-in:
- An event carries `block.number` and `block.hash` (both in `getEvents` results) for free.
- `block.timestamp` needs the header. Built: a contract declares it (`include: { block: true }`, typed:
  `event.block.timestamp` exists only then), the backfill fetches the headers of its blocks with events together
  with the batch's transactions, through the shared cache when final; live blocks already have theirs, so it's
  free there. (Not built: recording which fields handlers read, Ponder's column-access proxy.)
  `event.block` is the whole `BLOCK_HEADER` (`Block`, camelCase, gas prices as bigints, no `status`, which
  changes as the block settles): the same call returns it, so it costs nothing more. The cache keeps it as jsonb;
  rows cached with only a timestamp are fetched again. Blocks older than a field have `0x0`, `0` or `""` there.
- Headers are fetched in JSON-RPC batches of 100 (Alchemy: 835/s unbatched, 7,840/s batched). PublicNode
  throttles `getBlockWithTxHashes` to about 20/s whatever the batch size: header backfills go to a paid endpoint.

Transactions and receipts only for handlers that declare they need them (`include: { transaction: true }`), via
`getTransactionReceipt` or `getBlockWithReceipts` when many events share a block. They're typed
as the spec's unions (`TXN_WITH_HASH`: 11 shapes by type and version, query versions left out as they never reach
a chain; `TXN_RECEIPT_WITH_BLOCK_INFO` by type and execution status), camelCase, amounts as bigints, without the
receipt's `finality_status` (it changes as the block settles, like a header's `status`). The cache keeps the node's
JSON; it's converted once per transaction. Checked against mainnet samples of 9 kinds (`test/fixtures/
mainnet-transactions.json`): the node's fields matched the spec's exactly.

Felts have one outside form, `felt()`: `0x` and 64 lowercase digits, everywhere a handler or API user sees one, so
`===` compares them (`event.address` already was; hashes, `Block`, `Transaction`, `Receipt`, `event.log`,
`client.call` and `selector` were the node's form at first). Inside, felts stay as the node sends them:
the spec's `FELT` pattern forbids leading zeros, so requests (filters, `block_hash` pins, calls) and the reorg
table use that form, and the decoder accepts keys in both. Exception: `EthAddress` stays 40 digits.

## 6. Following the head

### 6.1 Polling (default; works on every provider)

Each tick (interval configurable, about one block time):
1. `starknet_blockHashAndNumber` → new tip `M` (and its hash).
2. `getEvents` from `last + 1` to `M` (explicit numbers), same single filter as backfill.
3. Headers for every new block, one batched request: each `parent_hash` must link to the block before, the first
   to the last indexed block, and every event's `block_hash` must match its header.

Cost: 3 HTTP requests per tick, independent of the number of contracts. Ponder's Starknet fork made one call per
child address per block.

Built (`src/sync/live.ts`). What a tick does when the answers don't agree:
- First header doesn't link to our head: walk back through the kept hashes to the common ancestor, revert, go on
  from there (a reorg deeper than the window is an error).
- A tip behind ours, a block the node doesn't have yet (error 24), a header chain that doesn't link, or an event
  whose block hash isn't its header's: an inconsistent (load-balanced, lagging) node. Nothing is indexed; retry next
  tick.
- Each live block is one transaction: its writes, its undo journal, its hash and the checkpoint. A crash leaves the
  last committed block; the restart re-checks it against the chain on its first tick.
- Class upgrades while live: a contract's `upgradeEvents` (default: `Upgraded`, `ClassHashReplaced`
  or `ImplementationReplaced` when its ABI declares them, as the OpenZeppelin, Ekubo and StarkWare components do)
  join the event filter. When one arrives in a block, its address's class is read at that block (one
  `getClassHashAt`), and the block decodes with the new class. A contract without any (not configured, none in
  its ABI) keeps the old check: before each tick, one batched `getClassHashAt(to)` per address, bisecting on a
  change. `upgradeEvents: []`: never checked. Measured on Ekubo (live, 30 min): 10.5k requests an hour,
  ≈4.4 per block, one of them this check, which the `ClassHashReplaced` default now removes. A Cairo 0 proxy never
  changes its own class (its implementation does), so neither way sees those upgrades: its events decode with the
  configured ABI.
- Restart after downtime: if the last indexed block is inside the window, its hash is checked first and a reorg
  that happened while stopped is reverted before backfilling (backfill trusts its start block).

### 6.2 WebSocket (opt-in)

Built (`src/sync/heads.ts`, config `ws: url | true`): `subscribeNewHeads` only wakes the follower,
which then does exactly what a poll does (tip, headers, parent-hash links, `getEvents`). So a dropped, silent or
lying socket can make it slower, never wrong. Reorg notices also just wake it. While the socket is up the
fallback poll is every max(`pollMs`, 15 s); while it's down, every `pollMs`, reconnecting with backoff (0.5 s to
30 s). A refused subscription logs once and stays on polling. Not `subscribeEvents`: it would need a resubscribe
for every new factory child, and its backfill is capped at 1,024 blocks.

Measured on Alchemy (which serves it fine): heads arrive ≈3 s after the block's timestamp. Ekubo
live, steady state, time from block timestamp to committed: polling every 2 s ≈5.4 s, WebSocket ≈4.5 s.

### 6.3 Pre-confirmed overlay (later)

`getEvents` with `from_block = to_block = "pre_confirmed"`. Pre-confirmed events have no block hash and can
change, repeat or disappear. Two options: expose them raw through the API, or run handlers in a transaction that
is always rolled back before the next confirmed block. To decide when we get there.

### 6.4 Finality and reorgs

- Data at or below `l1_accepted` (about 2.6 h behind the head) is irreversible.
- ACCEPTED_ON_L2 is treated as final, with a small safety window (e.g. 64 blocks) of hash-checked headers. On a
  `parent_hash` mismatch or a `subscriptionReorg`, revert to the common ancestor and refetch.
- **Undo journal instead of Ponder's triggers.** Every write goes through our store, so the store records the
  pre-image of each touched row in the journal, tagged with its block, only for blocks inside the safety window.
  Revert = replay pre-images backwards. Prune entries once their block leaves the window. No database triggers,
  no shadow table per user table, nothing during backfill. Raw SQL writes from handlers are not allowed (they
  would bypass the journal).

## 7. Indexing and writes (copied from Ponder, these work)

- Handlers run sequentially in checkpoint order. Checkpoint = `(block_number, transaction_index, event_index)`;
  one chain means no timestamps or chain ids in it.
- Past `maxCachedRows` (500k per table) the oldest-written rows are dropped and the table is no longer known in
  full. Plain inserts then skip the existence check (a query per insert: JediSwap's 7M swaps went from 50k to
  4k events/s); a duplicate is refused by the primary key when the batch is written, with the table and key in
  the error. `onConflictDo…`, `find` and `update` still read a missing row from Postgres.
- `context.db` writes are buffered in memory; flushed with `COPY` once per backfill batch (a few thousand
  events) and once per live block, in one transaction together with the checkpoint row.
- On a fresh run, tables live fully in memory until a memory cap, so reads in handlers never hit the database.
- Updates: COPY into a temp table, then `UPDATE … FROM`.
- Primary keys and user indexes come after the backfill (Ponder defers only user indexes). Measured on
  JediSwap's 7M-row `swaps` (key: tx hash + index, random order): commits took 68 s with the key and 17 s
  without, the run to block 150k 146 s → 94 s; building the key once at the end takes ~25 s. A table gets its
  key early when the store first needs it: an upsert or delete (`ON CONFLICT` needs it) or a read from
  Postgres (without it, a scan). So small updated tables are keyed at their first update and append-only ones
  at the end. A restart finds unkeyed tables in `pg_constraint`; live mode always has every key (journal,
  reverts). Each table is keyed in its own transaction, tables in parallel: `CREATE UNIQUE INDEX` (readers still
  read) then `ADD CONSTRAINT … PRIMARY KEY USING INDEX` (locked a moment). Measured on JediSwap: during the 31 s
  `swaps` key, API queries kept answering (31 of 32 ok, none over 2 s; one key transaction for every table had
  locked them all). Key columns are NOT NULL from the start, composite keys too, so a missing key part fails at
  once. The price: a key inserted twice that the cache no longer knows is reported when the key is built,
  not at that batch (the error says to fix the handler and reset). Drizzle `index()`/`uniqueIndex()`, `unique()`
  and `.unique()` are built then too (`IF NOT EXISTS`, at every start, so a new index needs no re-index). Their SQL
  is made at startup, and anything kasbah can't create as written (expressions, `where`, ordering, operator
  classes, storage options, foreign keys, checks) is refused then, not after hours of backfill.
- `synchronous_commit` stays on: ~75 commits per million-row backfill, the fsync isn't what costs.
- Crash recovery: resume from the last committed checkpoint. A journal for blocks above it is reverted first.
- One run (`src/indexer/run.ts`): setup (`open.ts`), then the phases factories → backfill → keys → live
  (`phases/`), each starting from the committed position (checkpoint, factory watermark, the window's hashes) and a
  no-op when it has nothing left, so a restart resumes through the same code. The position is a `Position`
  (`commit.ts`) whose fields only its own `commit` sets. Every write after startup is one of six commits (pre-pass
  children, backfill batch, entering live, live block, revert, done: a run with `to` indexed through it), all through that method: `moves()` says what each moves in
  `_kasbah_meta` (checkpoint and `pg_notify`, `discovered:*`, `phase`), and memory takes the same values only
  after COMMIT. Pre-pass children are resolved (classes read) before their transaction and watched after it.
- Prefetch profiling (Ponder's guess-the-key mechanism): only if measurements show handler reads are a bottleneck.

- Backfill blocks are final: no undo journal, and they go to the shared cache. So the backfill stops at `head -
  reorgWindow` even with a `to` above it (logged): a `to` near the head had cached blocks a reorg could still
  replace, for every app on the chain, with nothing to undo them in the app's own tables.

### 7.1 Transactions and receipts (opt-in per contract)

Built (`src/sync/extras.ts`): `include: { transaction?: true, receipt?: true }` on a contract gives its
handlers `event.transaction` with the transaction's RPC fields and `event.receipt`, typed only when asked for.
- One `getTransactionByHash` / `getTransactionReceipt` per transaction hash (deduplicated: 1,024 Ekubo events
  come from ≈209 transactions), batched by 100. Not `getBlockWithReceipts`: for the same events it moves 13 MB of
  whole blocks instead of ≈2 MB.
- Backfill fetches the next slice's data while the current one is handled; with `include`, batches are cut into
  slices of ≈2,000 events at block boundaries, so memory stays flat.
- Cached (final blocks, `cache: true`) in `transactions(hash, block, transaction jsonb, receipt jsonb)`, written
  in chunks with the commit; a commit also happens once 64 MB of it is waiting.
- Measured, Ekubo blocks 2.00M–2.02M (56k events, 15k transactions): without `include` 4 s; with both
  51–54 s from RPC (bound by Alchemy's compute units, ≈280 transactions/s) at 0.5–0.7 GB; again from the cache
  2.7 s. ≈5.2 KB per transaction cached, so full Ekubo history with receipts would be ≈40 GB.
- Found on the way: Alchemy throttles single calls inside a batch (HTTP 200, error 429 per call). The RPC client
  now resends only the failed calls, and throttling never uses up retry attempts (it waits out a pause instead,
  see §4).

## 8. ABIs, types and decoding

starknet.js (10.8.0) is used for what it is good at: hashing (`sn_keccak`, Pedersen/Poseidon via
`@scure/starknet`), and as the RPC types reference. Not for decoding on the hot path, and not for ABI types.

### 8.1 What real ABIs look like (checked on mainnet, files in `test/fixtures/`)

**Cairo 0** (`getClassAt` returns `{abi, program, entry_points_by_type}`):
- Event: `{"type":"event","name":"Upgraded","keys":[],"data":[{"name":"implementation","type":"felt"}]}`.
  Fields are `keys` and `data` arrays, **not** `inputs`.
- Types are `felt`, `felt*` (always preceded by a `<name>_len: felt` member), tuples `(felt, felt)`, and structs
  with `offset`/`size` (e.g. `Uint256 {low, high}`). No `core::` paths.
- At runtime: `keys[0] = sn_keccak(name)` and the rest of `keys` / `data` follow the ABI's `keys` / `data` lists.
  Many Cairo 0 contracts declare `keys: []`, so everything is in `data`.

**Cairo 1** (Ekubo Core):
- Events are a tree. The contract's root is an `event` of `kind: "enum"` (`ekubo::core::Core::Event`); its
  variants have `kind: "nested"` or `kind: "flat"` and point at structs or at component enums.
- Struct members have `kind: "key"` or `"data"`. Ekubo Core: 32 members, all `data`.
- **The selector comes from the variant path, not the struct name.** A nested variant adds
  `sn_keccak(variant name)` to `keys`; a flat variant adds nothing and lets the inner enum's variant speak; a
  struct then adds its `key` members. Ekubo live: `Swapped` → `keys = [sn_keccak("Swapped")]`, 21 data felts
  (130 events checked, all matched). `OwnedEvent` (nested, wrapping the `Owned` component enum) gives two keys:
  `[sn_keccak("OwnedEvent"), sn_keccak("OwnershipTransferred")]` (Cairo rule, to confirm in a test).
- Type strings: `core::integer::u8..u128`, `u256` (`[low, high]`), `i8..i128` (felts, negative = P − x),
  `core::felt252`, `ContractAddress`, `ClassHash`, `EthAddress`, `bytes31`, `ByteArray`
  (`[n_words, ...words, pending_word, pending_len]`), `Array<T>`/`Span<T>` (length-prefixed), `Option`/`Result`
  and user enums (variant index, then payload), tuples `(A, B)`, `NonZero<T>`, `core::bool` (an enum).

### 8.2 The fork's types (`ponder/packages/starknet-core/src/types/starknetAbi.ts`): what was wrong

The structure was good, but several facts were wrong.
1. **Cairo 0 events use `keys` / `data`, not `inputs`** (the type and its test ABI were made up; the test even
   used Cairo 1 type names like `core::integer::u256` in a Cairo 0 ABI).
2. **Cairo 0 types aren't mapped at all:** `felt`, `felt*` + `_len`, `Uint256`, tuples all fall to `unknown`.
3. **Cairo 1 `kind: "flat"` is missing** (`"key" | "data" | "nested"` only). Ekubo Core uses it.
4. **Events are found by the last segment of the struct name.** Wrong in general: the selector and the key layout
   come from the variant path from the root enum (see 8.1). Two components with an event of the same name, or a
   nested non-flat variant, break it.
5. **Enums are typed as their variant names only**, losing payloads (Cairo enums carry data). `Option`/`Result`
   are `unknown`; tuples aren't handled.
6. Function return types handle a single output only.

### 8.3 What kasbah does

**One ABI model, two parsers.** Cairo 0 and Cairo 1 ABIs are both turned into one internal model: a list of
**event leaves**, each with its full selector path (the `keys` prefix), its key members, its data members, and a
**decode plan**. Cairo 0 is the trivial case (path = `[sn_keccak(name)]`).

**Decode plans, built once per ABI:** a flat list of steps (`felt`, `u256`, `bool`, `byteArray`,
`array(plan)`, `enum(plans)`, `struct(plans)`, ...) run against `keys` and `data` with two cursors. No ABI walk,
no starknet.js `CallData` per event. Felts stay strings unless the type is numeric (`BigInt` then).

**Our own types, not abi-wan-kanabi.** abi-wan-kanabi (2.2.4, last release Dec 2024, what starknet.js uses) is
Cairo 1 only and names events by struct path. kasbah's types follow the same model as the runtime:
- Event names are the **variant path** (`"Swapped"`, `"OwnedEvent.OwnershipTransferred"`), computed in the type
  system from the root enum, so names in handler registrations match what's on chain.
- Handler args are typed from members, for both Cairo 0 (`felt` → `bigint`, `felt*` → `bigint[]` with the
  `_len` member folded in, structs by name) and Cairo 1 (full table in 8.1, enums as `{variant, value}` unions,
  `Option` / `Result` typed).
- Filter args (by key members) typed only for `key` members; Cairo 0 events with `keys: []` get none.
- Type tests (`*.test-d.ts`) run on **real ABIs fetched from mainnet** (Ekubo Core, a Cairo 0 contract, an
  OpenZeppelin ERC20), never hand-written ones, and the runtime decoder is tested on real events from the same
  contracts. That is what was missing in the fork.

**ABI source:** given in config as a `const` (for types), or fetched with `getClassAt` once and saved
(`kasbah abi <address>` writes a typed `.ts` file).

### 8.4 Upgraded contracts: decode with the class active at each block

Measured on Ekubo Core (§11.1): its class changed 22 times, and twice the events changed. With today's ABI, the
4.82M events before block 629,533 give 628 decode errors (`PoolInitialized` gained a field) and **324,430 events
silently unknown** (`ProtocolFeesPaid`, removed from today's ABI). Over the full history (55,074,891 events),
today's ABI silently drops **1,839,169** `ProtocolFeesPaid` events; with the class of each block, 0 errors and 0
unknown. So a "latest ABI only" indexer loses data without any error.

- At startup, `classHistory` (`src/abi/history.ts`) bisects `getClassHashAt` over the contract's range: ~25 calls
  per change (Ekubo: 22 classes in 358 calls, 1.9 s). Each class's ABI is fetched once (`getClass`) and cached.
- Events decode with the class active at their block (`createHistoricalDecoder`).
- Blind spot: a class replaced and restored between two probes (1M blocks apart by default) is missed. For
  factories, children's classes come from the same bisection, per child, lazily.
- Types: handlers are typed against the ABI given in config (normally the latest). An event whose layout differs
  in an older class decodes to that class's shape; config can declare older ABIs for an event so the handler gets
  a typed union. Events unknown to the config ABI but known to an older class are reported at startup, not dropped
  silently.

### 8.5 Cairo 0 proxies (found on JediSwap)

A Cairo 0 proxy's class (the one at its address) declares only the proxy's own events (`Upgraded`,
`AdminChanged`); everything the implementation emits comes out under the proxy's address with no ABI there.
JediSwap v1's factory and all 1,051 pairs are such proxies, as were Argent accounts and the bridged tokens.
- The configured ABI is the fallback: an event the class active at that block doesn't declare is decoded with
  it, and handled events of the configured ABI are always in the fetch filter. So for a proxy, configure the
  implementation's ABI (`get_implementation_hash`, then `getClass`).
- An event declared twice with the same layout (JediSwap pairs: `Transfer` with `from_` and with
  `from_address`) is accepted, the first declaration wins; two layouts for one selector are refused.
- A factory `parameter` that is a Cairo 0 `felt` (a bigint once decoded) is read as an address too.

Checked on mainnet (`examples/jediswap`, `check.ts`): JediSwap v1 to block 400k, 15.9M events, 89
pairs found by the factory pre-pass in 3.9 s, 7.3M swaps; every pair's reserves and tokens equal
`get_reserves`/`token0`/`token1` read through the proxy at block 400k (0 mismatches). 885 s at 1.8 GB peak.

### 8.6 Dev screen

`kasbah dev` (in a terminal; `--ui` / `--no-ui` override) draws `Status` (`src/indexer/status.ts`, filled in by `run`) under
the log and redraws it in place 4 times a second; the run's notices and handlers' `console` output print above it
and stay in the scrollback. `Status` is the run's only reporting channel: state read whenever (phase, blocks,
handlers, RPC, cache), and notices pushed in order to `subscribe` listeners (reorgs, class changes, phase summaries,
progress; each has a typed payload and its line of text). Without a `Status`, `run` prints every notice as a
`[kasbah]` line; the screen prints all but progress, which the box shows. Against Ponder's: one chain, so no
per-chain table; added a phase line (factories, backfill, keys, live), where the time goes (waiting for events, handlers, commits, and which one bounds the
run: the measure that found the bottlenecks in §8.5), handlers by total time with their average, and the last
commit's parts. Drawn as a box (phase badge, full-width progress bar, events/s sparkline over 2 minutes, the
time split as one stacked bar, handlers as a table), plain ANSI codes, no dependency; `NO_COLOR` or a non-TTY
turns colors off and leaves the layout. Time left: at the last 30 s's pace and at the phase's average; more than
1.5× apart, both are shown as a range (on Ekubo a single estimate swung between 1h 43m and 4h). `start` keeps
plain log lines, better for Docker and log files. Skipped events are reported once per contract and event name
(Ekubo Core's 20 upgrades printed 20 identical lines), and the CLI hides Node's type-stripping warning.

## 9. Storage and caches

**Raw-event cache** (for re-index without RPC), schema `kasbah_cache_<chain id>`, opt-in (`cache: true`) (`src/db/cache.ts`):
- `events(block, tx, idx, address, selector, block_hash, tx_hash, keys, data)`, primary key = the three ints.
  `keys` and `data` are one bytea each: per felt a length byte and its minimal big-endian bytes (most felts are
  small numbers).
- `headers(block, hash, parent, timestamp)` for the blocks whose headers were fetched (block handlers).
- `coverage(address, selector, ranges int8multirange)`: which (address, selector) pairs are complete for which
  blocks. Ponder's fragment idea, without its EVM topic cross-products.
- Only data below the safety window is cached, so the cache never needs reorg handling.
- A backfill reads the prefix of its range that every (address, selector) pair covers from the cache, then fetches
  the rest; fetched events and coverage are written in the same transaction as the app's checkpoint.
- Reads page by position (`LIMIT` 50k, a batch never ends inside a block) and get hex text from Postgres
  (`encode(.., 'hex')`), skipping the Buffer round trip.
- Measured, Ekubo to block 700k (7.68M events): 3.3 GB (≈430 bytes per event; full history would be
  ≈24 GB). Indexing from RPC while writing the cache 232 s; re-index from the cache 132 s, zero `getEvents`.
  Possible later: block hashes and addresses as ids instead of 32 bytes per row.

**Call cache** (`context.client`, the readContract equivalent): key = `(block, address, selector, calldata)`,
immutable once the block is final. Ponder never prunes its `eth_call` cache, which is where your 38 GB came from.
Built (`src/indexer/client.ts`, `src/abi/functions.ts`):
- `context.client.readContract({ abi, address, functionName, args, block? })`, typed from the ABI (arguments as an object
  keyed by input name; result: one Cairo 1 output as its value, several as a tuple, Cairo 0 named outputs as an
  object). `client.call` for raw calldata. Default block: the one being indexed, state at its end.
- Final blocks: cached in memory (100k results, oldest dropped) and, with `cache: true`, in the cache schema's
  `calls` table, written in the commit transactions. Recent blocks: never cached, and pinned by block hash so a
  lagging or reorged node can't answer for another block at that height.
- Checked on mainnet: Ekubo `get_pool_liquidity` / `get_pool_price` at block 700k equal what the indexer computed
  from events up to that block.
- Capped: `cache: { maxCalls }`, default 1M rows; past it the oldest inserted are dropped down to
  90% (insertion order, `seq`, not last use: a hit costs no write). Checked at open, so lowering the cap prunes at
  once. `kasbah cache info` / `kasbah cache clear` (§11) show and empty each chain's cache.
- Not yet: batching reads made in parallel by a handler.

## 10. What we drop from Ponder, with its size

About 43k lines in Ponder's `core/src`. Not needed here:
- multichain/omnichain/isolated ordering (`runtime/omnichain.ts`, `multichain.ts`, `isolated.ts`, merge
  generators), about 2.6k lines
- blooms, `eth_getLogs` range guessing, EVM `standardize*`/`validate*`, about 2k lines
- trace/transfer/transaction filters and their fragments, a large part of `runtime/filter.ts` and
  `fragments.ts`
- Multicall3 and viem integration in `indexing/client.ts`
- reorg triggers and per-table shadow tables
- `ponder dev` drop-and-rebuild, the views schema (maybe later), live-query NOTIFY (maybe later)
- `utils/sql-parse.ts` (1.5k lines, libpg-query) used only for raw-SQL flush logic

Target size: under 10k lines for v1.

## 11. Build order

0. **ABI model + decoder + types**, tested on the real ABIs and events in `test/fixtures/` (Cairo 0 and Ekubo).
   Small, independent, and everything else depends on it.
1. **Spike: fetcher benchmark.** Endpoint probe + backfill fetcher only, printing events/s. Run on a real
   Ekubo history against Alchemy, Cartridge (Pathfinder) and PublicNode (Juno), and compare with the Ponder fork.
   This validates the core bet before writing anything else.
   Done, results in §11.1.
2. Decoder, config, schema, handlers, buffered store with COPY. Backfill end to end.
   Done.
3. Raw-event cache + coverage; re-index with zero RPC calls. (Moved after 5: a full Ekubo refetch costs $0.57.)
   Done, with factories (§5.2) and block-interval handlers: config `blocks: { Name: { interval,
   startBlock, endBlock? } }`, handler `"Name:block"` with the block's number, hash and timestamp, run after that
   block's events; headers are fetched only for the blocks it fires on.
4. Live polling, undo journal, crash recovery. Done.
5. Read API. Done (`src/api/`):
   - `POST /sql` `{ sql, params }` → `{ columns, rows }`. Runs as `<schema>_reader`, a login role kasbah creates
     (or `api.readDatabase`) with SELECT on the app's tables and `_kasbah_meta` only. Each query: one read-only
     transaction with a timeout (10 s), always rolled back, so nothing it sets outlives it; sent wrapped as
     `SELECT * FROM (<sql>) LIMIT $n` with the extended protocol, so only one SELECT/WITH/VALUES statement parses;
     at most 10,000 rows.
   - `POST /graphql`: per table `pool(<primary key>)` and `pools(where, orderBy, orderDirection, limit, after)`,
     keyset paging on non-null columns with the primary key as tiebreak; filters `x`, `x_not`, `x_in`,
     `x_not_in`, `x_gt/gte/lt/lte`, `AND`, `OR`. Numbers past 32 bits are `BigInt` decimal strings. `_meta`.
   - `GET /status`: checkpoint and phase (backfill or live).
   - Live queries: `GET /live` streams server-sent events. Every commit (backfill batch, live
     block, reorg revert) runs `pg_notify('kasbah_<schema>', {"checkpoint": n})` inside its transaction, so
     the notice only arrives once the data is visible, and an API process anywhere on the same database gets it
     via `LISTEN`. Plain `/live` sends `event: checkpoint`; with `?sql=…&params=[…]` or
     `?query=…&variables={…}` (GraphQL), the query runs at once and after each commit, and `event: result` is
     sent only when the result changed (one run at a time per stream, commits during a run coalesce). A bad query
     is a plain 400 before the stream opens. Readers can't fake a notice: their transactions always roll back,
     and Postgres delivers notices only on commit (mutation-checked). Checked on mainnet with Ekubo live.
   - GraphQL relations: declared with Drizzle's `relations()` next to the tables (`tables`
     takes both, so `import * as schema` works, as in Ponder). A to-one field is the related row, batched: all
     lookups of one level go out as one `WHERE (cols) IN (…)`. A to-many field is a page with the top-level
     list's arguments (`where`, `orderBy`, `orderDirection`, `limit`, `after`), also one statement per level:
     the page query runs per parent in a `LATERAL` subquery over `VALUES` of the parents' keys. Each
     request has a budget: 500 statements and the query timeout in total. A relation named like a column is
     refused at startup.
   - GraphQL limits: before a query runs, at most 1,000 tokens (graphql-js `maxTokens`), depth
     20 and 30 aliases, fragments counted where spread (Ponder: 1,000 / 100 / 30; depth is lower here because each
     nested relation is a statement). GraphiQL's introspection query fits. The statement budget stays behind them.
   - The app's routes: `app.get(path, handler)` / `app.post`, `:name` path segments, matched
     after the built-in paths (which they can't take). The handler gets `db`, a Drizzle database typed with the
     app's tables (relational queries included) on the reader's read-only transaction and timeout, plus `params`,
     `query`, `body` and the request; what it returns is sent as JSON, a `Response` as is, an `HttpError` as its
     status. Ponder's equivalent is a user Hono app; this keeps the API dependency-free.
   - `GET /health`: 200 while the process and its database answer. `GET /ready`: 200 once the phase is live (or
     done: a run with `to` that indexed through it, keys built), else 503 with the phase. Auth, rate limits and TLS are left to a proxy in front, as in Ponder.
   - Not yet: sharing one live run between streams with the same query.
6. Opt-ins: WebSocket mode, pre-confirmed overlay, class-hash factories, call/trace handlers.

CLI (`src/cli/main.ts`): `kasbah start <app>`, `kasbah dev <app>`, `kasbah cache info|clear`. The app
module default-exports `kasbah(config)` with its handlers. `dev` runs `start` in a child process and restarts it
on any code-file change under the app's directory (ES modules can't be unloaded, so a fresh process is the
reliable reload), with `onBuildChange: "reset"`. The build id now includes each handler's source and the CLI's
hash of the app's code files: before, a handler body edit kept stale results. The compiled build for a registry
was done the same day (`dist/`, `pnpm pack`).

Database for `dev` (`src/cli/devdb.ts`): without `DATABASE_URL`, `dev` runs `postgres:17` in Docker
or Podman, one container and named volume per app directory (its basename and a hash of its path), published on a
free localhost port, and waits until TCP connects (the image's first start runs a socket-only server while it
initialises). Stopped when `dev` exits, kept for the next run. Chosen over PGlite (single connection: no separate
read-only role, API reads queued behind writes, an in-process stand-in for LISTEN) and embedded Postgres binaries:
it is the same Postgres as production, and the generated compose file already assumes Docker. `start` never starts
one. `pnpm create kasbah` is the `create/` package: it runs the installed `kasbah init`.

`serve`: `kasbah serve <app>` (`app.serve()`) runs the API alone over the app's schema,
like `ponder serve`: an index finished with `--to`, or API processes next to one indexer.

Ekubo example (`examples/ekubo/`): candles per pool per hour and day (OHLC from `sqrt_ratio`,
volume, fees on the input side, balances after the last event, so TVL per candle), balances from the signed deltas
of swaps, positions, collected fees and accumulated fees, protocol totals snapshotted by a block handler. A handler's
`db` only reads by key, so "every changed pool" can't be listed in a block handler: per-candle TVL does that job.
Deployment to block 300,000: 652,647 events in 158 s; hourly sums equal each pool's totals, daily equal hourly, the
last candle's balances equal the pool's, no negative balance, no OHLC out of order. ETH/USDC 0.05% closes at
$1,647 (October 2023). The cost is the timestamps: 79,184 headers for that range, one per block with events.

### 11.1 Fetcher benchmark (Ekubo Core, from a 100 Mbit/s home link)

`scripts/bench.ts`. Every run of the same range gave the same event count and checksum, on every endpoint and in
every mode.

500k blocks (16.0M–16.5M), 1,233,321 events:

| Endpoint | Sequential | Parallel ×32 |
|---|---|---|
| Alchemy (Pathfinder, paid) | 7,594/s | 93,963/s; **117,031/s** with zstd |
| PublicNode (Juno, free) | 16,924/s | 94,734/s (br) |
| Cartridge (Pathfinder, free) | 2,736/s | 4,893/s (throttled, concurrency fell to 7, no failures) |

- ×64 and ×128 were no faster: the link was the limit (11.5 MB/s of compressed JSON against a 12.4 MB/s line;
  main thread 54% idle). On a server, expect several times more.
- JSON is ~870 bytes per Ekubo event; gzip 7×, zstd 9×. Node's fetch decodes gzip and br but not zstd, so the
  client asks for `zstd, br, gzip` and decompresses zstd itself.
- Decoding: ~1.4 µs per event, about 1% of the time.

Full history (blocks 165,392–17,101,222): **55,074,576 events in 652 s** (84k/s), 54,006 calls ≈ 1.08M CU ≈
$0.57 on Alchemy, no retries. 5,171,698 blocks have events, so headers would be ≈ 103M CU ≈ $54 (§5.4).

Headers: Alchemy 835/s unbatched, 7,840/s in batches of 100. PublicNode ~20/s at any batch size.

## 12. Decisions

1. Name: **kasbah**. Repo at `~/Desktop/kasbah`, not public yet.
2. One chain per process.
3. API: SQL over HTTP and GraphQL.
4. Schema: Drizzle.
5. First test target: Ekubo pools.
6. Cairo 0 and Cairo 1 contracts both supported. Own ABI types (§8), starknet.js for hashing and RPC types.

---

## Appendix A: measured limits

**Spec / Alchemy (Pathfinder-like) live probes:**
- `chunk_size` max 1024 (1025 → error 31). Key positions max 16 (17 → error 34); no limit seen on values per
  position (1,024 accepted). 5,000 addresses accepted. `address: []` = no filter.
- One call scans at most 81,920 blocks and may return zero events plus a token.
- Token format `"<block>-<n>"`, stateless (survives restarts on the same node type).
- Results sorted by `(block, tx_index, event_index)`.
- `l1_accepted` lag: ~5,674 blocks (~2.6 h).
- Pre-confirmed events: `block_number` but no `block_hash`; the pre-confirmed block is reachable only by tag.
- JSON-RPC batches work.
- Alchemy WS: non-compliant (no address arrays, no `event_index`/`finality_status`, backfill ignored,
  `subscribeNewTransactionReceipts` missing).

**Nodes (source):**

| | Pathfinder | Juno | Madara |
|---|---|---|---|
| Max `chunk_size` | 1024 | 10240 | 1000 |
| Key limit | 16 positions | 1024 total | 100 total |
| Block scan per call | 81,920 | unlimited (default) | unlimited |
| Multi-address | one pass (ORed blooms) | one pass | **slow: unfiltered scan for 2+ addresses** |
| Batch max / concurrency | 100 / sequential | 1000 / parallel | unlimited |
| WS | off by default, 1,024 blocks back, 1 s send timeout | off by default, 1,024 blocks back | 1,024 blocks back |
| Token `n` counts | matched events | raw events | depends |

**Providers:** Alchemy (Pathfinder, 20 CU per call, WS non-compliant), Chainstack (Pathfinder 0.24, 1 RU per
call, flat-fee option), Voyager/Nethermind (Juno, sticky routing), PublicNode (free, Juno, WS works, chunk
10240, batch 1000), Cartridge (free, Pathfinder, no WS). Blast and Lava public are shut down; dRPC free tier
doesn't serve Starknet.

**Existing Starknet indexers:** Apibara DNA v2 (own ingester + columnar block store + gRPC streams; the reference
if we ever outgrow RPC), Checkpoint (per-contract `getEvents`, sequential), Torii (batched multi-contract
`getEvents`, 1024-call batches that a stock Pathfinder would reject). None uses address arrays + parallel
aligned windows + a factory pre-pass.
