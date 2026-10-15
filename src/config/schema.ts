import { customType } from "drizzle-orm/pg-core";

/** Any Cairo integer up to u256 (and i129-style signed values): `numeric(78, 0)` in Postgres, `bigint` in JS. */
export const bignum = customType<{ data: bigint; driverData: string }>({
  dataType: () => "numeric(78, 0)",
  toDriver: (v) => v.toString(),
  fromDriver: (v) => BigInt(v),
});

/** A felt kept as hex: addresses, class hashes, transaction hashes. */
export const hex = customType<{ data: `0x${string}`; driverData: string }>({
  dataType: () => "text",
});
