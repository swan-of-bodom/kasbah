import { createDecoder, type EventArgs, type EventName, type TypeOf } from "../src/index.ts";
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
