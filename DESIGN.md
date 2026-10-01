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
  selector key, see `research/abis/`).

**Later, opt-in:** pre-confirmed overlay (§6.3), class-hash factories (§5.3), call/trace handlers
(`traceBlockTransactions`), WebSocket live mode (§6.2), storage-diff handlers (`getStateUpdate`).

**Never:** EVM support, bloom filters, provider error-string parsing, Multicall3 splitting, trace/transfer filters
in core, the `ponder dev` drop-everything mode.

## 3. Architecture

```
            ┌──────────────── endpoint layer (§4) ─────────────────┐
            │ capability probe · adaptive concurrency · pinning    │
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
- Adaptive concurrency per endpoint (AIMD: grow on success, halve on 429/timeout), several endpoints with
  latency-based routing. Ponder's `rpc/index.ts` is a good model and is chain-agnostic.
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

### 5.3 Class-hash factories (later)

`getStateUpdate(block).state_diff.deployed_contracts` lists every deployment with its class hash, including
`deploy_syscall`s that emit no event. But it is one call per block, with no range query. That is cheap live
(one call per block) and too expensive for full history (17M calls). Historical discovery would need the
Universal Deployer's `ContractDeployed` event (covers UDC deployments only) or a known start block.

### 5.4 Block headers

`getEvents` results have no timestamp. Fetch headers only for **blocks that have matched events**, deduplicated,
in parallel (`getBlockWithTxHashes`; there is no header-only HTTP method). Transactions and receipts only for
handlers that declare they need them (`include: { transaction: true }`), via `getTransactionReceipt` or
`getBlockWithReceipts` when many events share a block.

## 6. Following the head

### 6.1 Polling (default; works on every provider)

Each tick (interval configurable, about one block time):
1. `starknet_blockHashAndNumber` → new tip `M` (and its hash).
2. `getEvents` from `last + 1` to `M` (explicit numbers), same single filter as backfill.
3. Headers for blocks with events; verify `parent_hash` links against the last known header.

Cost: about 2–3 calls per tick, independent of the number of contracts. Ponder's Starknet fork made one call per
child address per block.

### 6.2 WebSocket (opt-in, when the probe passes)

`subscribeNewHeads` for tip and headers (no polling), then `getEvents` by block hash for each head. Not
`subscribeEvents`: it would need a resubscribe for every new factory child. Handle `starknet_subscriptionReorg`.
Read the socket in a tight loop and queue work (Pathfinder drops a client that doesn't read within 1 s). On
reconnect, fill gaps with `getEvents` (WS backfill is capped at 1,024 blocks).

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
- `context.db` writes are buffered in memory; flushed with `COPY` once per backfill batch (a few thousand
  events) and once per live block, in one transaction together with the checkpoint row.
- On a fresh run, tables live fully in memory until a memory cap, so reads in handlers never hit the database.
- Updates: COPY into a temp table, then `UPDATE … FROM`.
- User indexes are created after the backfill.
- Crash recovery: resume from the last committed checkpoint. A journal for blocks above it is reverted first.
- Prefetch profiling (Ponder's guess-the-key mechanism): only if measurements show handler reads are a bottleneck.

## 8. ABIs, types and decoding

starknet.js (10.8.0) is used for what it is good at: hashing (`sn_keccak`, Pedersen/Poseidon via
`@scure/starknet`), and as the RPC types reference. Not for decoding on the hot path, and not for ABI types.

### 8.1 What real ABIs look like (checked on mainnet, files in `research/abis/`)

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
(`kasbah abi <address>` writes a typed `.ts` file). A contract upgraded to a new class (`replaced_classes`)
can change ABI: config allows an ABI per block range.

## 9. Storage and caches

**Raw-event cache** (for re-index without RPC), schema `cache`:
- `events(block_number int8, tx_index int4, event_index int4, from_address bytea, keys bytea[], data bytea[],
  tx_hash bytea)`, primary key = the three ints. Felts as bytea (about half the size of hex text).
- `headers(block_number, block_hash, parent_hash, timestamp)` for blocks with events only.
- `coverage(address, selector, ranges int8multirange)`: which (address, selector) pairs are complete for which
  blocks. Ponder's fragment idea, without its EVM topic cross-products.
- Only data below the safety window is cached, so the cache never needs reorg handling.

**Call cache** (`context.call`, the readContract equivalent): key = `(block, address, selector, calldata)`,
immutable once the block is final. Ponder never prunes its `eth_call` cache, which is where your 38 GB came from.
Here: per-call `cache: "block" | "latest" | "none"`, an explicit size cap with oldest-first pruning, and
`indexer prune` as a command.

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

0. **ABI model + decoder + types**, tested on the real ABIs and events in `research/abis/` (Cairo 0 and Ekubo).
   Small, independent, and everything else depends on it.
1. **Spike: fetcher benchmark.** Endpoint probe + backfill fetcher only, printing events/s. Run on a real
   Ekubo history against Alchemy, Cartridge (Pathfinder) and PublicNode (Juno), and compare with the Ponder fork.
   This validates the core bet before writing anything else.
2. Decoder, config, schema, handlers, buffered store with COPY. Backfill end to end.
3. Raw-event cache + coverage; re-index with zero RPC calls.
4. Live polling, undo journal, crash recovery.
5. Read API.
6. Opt-ins: WebSocket mode, pre-confirmed overlay, class-hash factories, call/trace handlers.

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
