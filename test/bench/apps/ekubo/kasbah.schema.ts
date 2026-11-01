import { bignum, hex, integer, jsonb, pgTable, text } from "kasbah";

export const classHashReplaced = pgTable("class_hash_replaced", {
  id: text().primaryKey(),
  block: integer().notNull(),
  transaction: text().notNull(),
  new_class_hash: hex().notNull(),
});

export const ownedEventOwnershipTransferred = pgTable("owned_event_ownership_transferred", {
  id: text().primaryKey(),
  block: integer().notNull(),
  transaction: text().notNull(),
  old_owner: hex().notNull(),
  new_owner: hex().notNull(),
});

export const protocolFeesWithdrawn = pgTable("protocol_fees_withdrawn", {
  id: text().primaryKey(),
  block: integer().notNull(),
  transaction: text().notNull(),
  recipient: hex().notNull(),
  token: hex().notNull(),
  amount: bignum().notNull(),
});

export const poolInitialized = pgTable("pool_initialized", {
  id: text().primaryKey(),
  block: integer().notNull(),
  transaction: text().notNull(),
  pool_key: jsonb(),
  initial_tick: jsonb(),
  sqrt_ratio: bignum().notNull(),
});

export const positionUpdated = pgTable("position_updated", {
  id: text().primaryKey(),
  block: integer().notNull(),
  transaction: text().notNull(),
  locker: hex().notNull(),
  pool_key: jsonb(),
  params: jsonb(),
  delta: jsonb(),
});

export const positionFeesCollected = pgTable("position_fees_collected", {
  id: text().primaryKey(),
  block: integer().notNull(),
  transaction: text().notNull(),
  pool_key: jsonb(),
  position_key: jsonb(),
  delta: jsonb(),
});

export const swapped = pgTable("swapped", {
  id: text().primaryKey(),
  block: integer().notNull(),
  transaction: text().notNull(),
  locker: hex().notNull(),
  pool_key: jsonb(),
  params: jsonb(),
  delta: jsonb(),
  sqrt_ratio_after: bignum().notNull(),
  tick_after: jsonb(),
  liquidity_after: bignum().notNull(),
});

export const savedBalance = pgTable("saved_balance", {
  id: text().primaryKey(),
  block: integer().notNull(),
  transaction: text().notNull(),
  key: jsonb(),
  amount: bignum().notNull(),
});

export const loadedBalance = pgTable("loaded_balance", {
  id: text().primaryKey(),
  block: integer().notNull(),
  transaction: text().notNull(),
  key: jsonb(),
  amount: bignum().notNull(),
});

export const feesAccumulated = pgTable("fees_accumulated", {
  id: text().primaryKey(),
  block: integer().notNull(),
  transaction: text().notNull(),
  pool_key: jsonb(),
  amount0: bignum().notNull(),
  amount1: bignum().notNull(),
});

export const extensionCallPointsSet = pgTable("extension_call_points_set", {
  id: text().primaryKey(),
  block: integer().notNull(),
  transaction: text().notNull(),
  extension: hex().notNull(),
  call_points: jsonb(),
});
