import type { Column } from "drizzle-orm";
import { toSnakeCase } from "drizzle-orm/casing";
import {
  customType,
  pgTable as drizzlePgTable,
  type PgColumnBuilderBase,
  type PgTableFn,
} from "drizzle-orm/pg-core";

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

type Columns = Record<string, PgColumnBuilderBase>;

/** Names each column after its key in snake_case (`sqrtRatio` → `sqrt_ratio`), unless the column names itself. */
function snakeNamed<C extends Columns>(columns: C): C {
  for (const [key, builder] of Object.entries(columns))
    (builder as unknown as { setName(name: string): void }).setName(toSnakeCase(key));
  return columns;
}

/**
 * Drizzle's `pgTable`, with columns named in snake_case in Postgres: the TypeScript keys stay as written, and SQL
 * clients that compile queries with snake_case casing find the columns.
 */
export const pgTable = ((name: string, columns: Columns | ((t: never) => Columns), extra?: never) =>
  (drizzlePgTable as (...args: unknown[]) => unknown)(
    name,
    typeof columns === "function" ? (t: never) => snakeNamed(columns(t)) : snakeNamed(columns),
    extra,
  )) as PgTableFn;

const madeWith = (column: Column, params: object) =>
  column.columnType === "PgCustomColumn" &&
  (column as unknown as { config: { customTypeParams?: object } }).config.customTypeParams ===
    params;

/** Whether `column` was made with `bignum()`. */
export const isBignum = (column: Column): boolean => madeWith(column, BIGNUM);

/** Whether `column` was made with `hex()`. */
export const isHex = (column: Column): boolean => madeWith(column, HEX);
