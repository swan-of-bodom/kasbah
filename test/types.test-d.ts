import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { createDecoder, type EventArgs, type EventName, type IndexedEvent, type Block, kasbah, type TypeOf } from "../src/index.ts";
import cairo0Pair from "./fixtures/cairo0-0.abi.ts";
import ekubo from "./fixtures/ekubo-core.abi.ts";
import strk from "./fixtures/strk.abi.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function assert<_ extends true>() {}

type Hex = `0x${string}`;
type I129 = { mag: bigint; sign: boolean };
type PoolKey = { token0: Hex; token1: Hex; fee: bigint; tick_spacing: bigint; extension: Hex };

assert<Equal<
  EventName<typeof ekubo>,
  | "ClassHashReplaced" | "OwnedEvent.OwnershipTransferred" | "ProtocolFeesWithdrawn" | "PoolInitialized"
  | "PositionUpdated" | "PositionFeesCollected" | "Swapped" | "SavedBalance" | "LoadedBalance" | "FeesAccumulated"
  | "ExtensionCallPointsSet"
>>();

assert<Equal<EventArgs<typeof ekubo, "Swapped">, {
  locker: Hex;
  pool_key: PoolKey;
  params: { amount: I129; is_token1: boolean; sqrt_ratio_limit: bigint; skip_ahead: bigint };
  delta: { amount0: I129; amount1: I129 };
  sqrt_ratio_after: bigint;
  tick_after: I129;
  liquidity_after: bigint;
}>>();

assert<Equal<EventArgs<typeof ekubo, "OwnedEvent.OwnershipTransferred">, { old_owner: Hex; new_owner: Hex }>>();

assert<Equal<Extract<EventName<typeof strk>, "Transfer" | "Approval">, "Transfer" | "Approval">>();
assert<Equal<EventArgs<typeof strk, "Transfer">, { from: Hex; to: Hex; value: bigint }>>();

assert<Equal<EventName<typeof cairo0Pair>, "Transfer" | "Approval" | "Mint" | "Burn" | "Swap" | "Sync">>();
assert<Equal<EventArgs<typeof cairo0Pair, "Transfer">, { from_: bigint; to: bigint; value: bigint }>>();
assert<Equal<EventArgs<typeof cairo0Pair, "Sync">, { reserve0: bigint; reserve1: bigint }>>();

// Type strings, against the same rules codec.ts implements.
type None = readonly [];
assert<Equal<TypeOf<None, "core::option::Option::<core::integer::u256>">, bigint | null>>();
assert<Equal<TypeOf<None, "@core::array::Array::<core::felt252>">, bigint[]>>();
assert<Equal<TypeOf<None, "(core::bool, core::integer::u32)">, [boolean, number]>>();
assert<Equal<TypeOf<None, "(x : felt, y : felt)">, { x: bigint; y: bigint }>>();
assert<Equal<
  TypeOf<None, "core::result::Result::<core::array::Array::<core::felt252>, core::felt252>">,
  { ok: bigint[] } | { err: bigint }
>>();
assert<Equal<TypeOf<None, "core::internal::bounded_int::BoundedInt::<0, 30>">, bigint>>();
assert<Equal<TypeOf<None, "core::byte_array::ByteArray">, string>>();

const decode = createDecoder(ekubo);
const decoded = decode([], []);
if (decoded?.name === "Swapped") {
  const sqrt: bigint = decoded.args.sqrt_ratio_after;
  const token: Hex = decoded.args.pool_key.token0;
  void sqrt;
  void token;
}

// Functions.
import type { FunctionArgs, FunctionName, FunctionResult } from "../src/index.ts";

assert<Equal<"get_pool_liquidity" extends FunctionName<typeof ekubo> ? true : false, true>>();
assert<Equal<FunctionArgs<typeof ekubo, "get_pool_liquidity">, { pool_key: PoolKey }>>();
assert<Equal<FunctionResult<typeof ekubo, "get_pool_liquidity">, bigint>>();
assert<Equal<FunctionResult<typeof cairo0Pair, "getReserves">, { reserve0: bigint; reserve1: bigint; blockTimestampLast: bigint }>>();
assert<Equal<FunctionArgs<typeof cairo0Pair, "getReserves">, {}>>();

// include.block adds the whole header, and its hash is then always known.
const config = {
  rpc: "", database: "", tables: {},
  contracts: { Plain: { abi: ekubo, address: "0x1", startBlock: 0 }, Timed: { abi: ekubo, address: "0x2", startBlock: 0, include: { block: true } } },
} as const;
type Cfg = typeof config;
assert<Equal<IndexedEvent<Cfg, "Plain:Swapped">["block"], { number: number; hash: string | undefined }>>();
assert<Equal<IndexedEvent<Cfg, "Timed:Swapped">["block"], Block>>();
kasbah(config).on("Timed:Swapped", ({ event }) => void (event.block.l2GasPrice.fri satisfies bigint));
kasbah(config).on("Timed:Swapped", ({ event }) => void event.block.timestamp);
// @ts-expect-error: no timestamp without include.block
kasbah(config).on("Plain:Swapped", ({ event }) => void event.block.timestamp);

// upgradeEvents are events of the contract's ABI.
kasbah({ ...config, contracts: { Core: { abi: ekubo, address: "0x1", startBlock: 0, upgradeEvents: ["ClassHashReplaced"] } } });
// @ts-expect-error: not an event of the ABI
kasbah({ ...config, contracts: { Core: { abi: ekubo, address: "0x1", startBlock: 0, upgradeEvents: ["Upgraded"] } } });

// Routes: `db` knows the app's tables, relational queries included.
const swapsTable = pgTable("swaps", { id: text().primaryKey(), amount: integer().notNull() });
const routed = kasbah({ ...config, tables: { swapsTable }, api: { port: 0 } });
routed.get("/swaps/:id", async ({ db, params }) => {
  const row = await db.query.swapsTable.findFirst({ where: (t, { eq }) => eq(t.id, params.id!) });
  const amount: number | undefined = row?.amount;
  // @ts-expect-error: no such table
  void db.query.nope;
  return amount;
});

// include.transaction: the spec's union, narrowed by type and version.
const withTx = kasbah({ rpc: "", database: "", tables: {}, contracts: { T: { abi: ekubo, address: "0x2", startBlock: 0, include: { transaction: true, receipt: true } } } });
withTx.on("T:Swapped", ({ event }) => {
  const tx = event.transaction;
  // @ts-expect-error not every transaction has a sender (INVOKE v0, L1_HANDLER, DEPLOY*)
  void tx.senderAddress;
  if (tx.type === "INVOKE" && tx.version === "0x3") void (tx.resourceBounds.l2Gas.maxPricePerUnit satisfies bigint);
  if (tx.type === "L1_HANDLER") {
    void (tx.nonce satisfies bigint);
    // @ts-expect-error L1 handlers carry no signature
    void tx.signature;
  }
  if (event.receipt.type === "L1_HANDLER") void (event.receipt.messageHash satisfies `0x${string}`);
  void (event.log.keys[0] satisfies `0x${string}` | undefined);
});
