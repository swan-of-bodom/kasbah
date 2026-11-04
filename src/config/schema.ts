import type { Column } from "drizzle-orm";
import { customType } from "drizzle-orm/pg-core";

const BIGNUM = {
  dataType: () => "numeric(78, 0)",
  toDriver: (v: bigint) => v.toString(),
  fromDriver: (v: string) => BigInt(v),
};

const HEX = { dataType: () => "text" };

/** Any Cairo integer up to u256 (and i129-style signed values): `numeric(78, 0)` in Postgres, `bigint` in JS. */
export const bignum = customType<{ data: bigint; driverData: string }>(BIGNUM);

/** A felt kept as hex: addresses, class hashes, transaction hashes. */
export const hex = customType<{ data: `0x${string}`; driverData: string }>(HEX);

const madeWith = (column: Column, params: object) =>
  column.columnType === "PgCustomColumn" &&
  (column as unknown as { config: { customTypeParams?: object } }).config.customTypeParams ===
    params;

/** Whether `column` was made with `bignum()`. */
export const isBignum = (column: Column): boolean => madeWith(column, BIGNUM);

/** Whether `column` was made with `hex()`. */
export const isHex = (column: Column): boolean => madeWith(column, HEX);
