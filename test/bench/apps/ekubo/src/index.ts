import app from "../kasbah.config.ts";
import * as schema from "../kasbah.schema.ts";

app.on("Core:ClassHashReplaced", async ({ event, context }) => {
  await context.db.insert(schema.classHashReplaced).values({
    id: `${event.transaction.hash}:${event.index}`,
    block: event.block.number,
    transaction: event.transaction.hash,
    new_class_hash: event.args.new_class_hash,
  });
});

app.on("Core:OwnedEvent.OwnershipTransferred", async ({ event, context }) => {
  await context.db.insert(schema.ownedEventOwnershipTransferred).values({
    id: `${event.transaction.hash}:${event.index}`,
    block: event.block.number,
    transaction: event.transaction.hash,
    old_owner: event.args.old_owner,
    new_owner: event.args.new_owner,
  });
});

app.on("Core:ProtocolFeesWithdrawn", async ({ event, context }) => {
  await context.db.insert(schema.protocolFeesWithdrawn).values({
    id: `${event.transaction.hash}:${event.index}`,
    block: event.block.number,
    transaction: event.transaction.hash,
    recipient: event.args.recipient,
    token: event.args.token,
    amount: event.args.amount,
  });
});

app.on("Core:PoolInitialized", async ({ event, context }) => {
  await context.db.insert(schema.poolInitialized).values({
    id: `${event.transaction.hash}:${event.index}`,
    block: event.block.number,
    transaction: event.transaction.hash,
    pool_key: event.args.pool_key,
    initial_tick: event.args.initial_tick,
    sqrt_ratio: event.args.sqrt_ratio,
  });
});

app.on("Core:PositionUpdated", async ({ event, context }) => {
  await context.db.insert(schema.positionUpdated).values({
    id: `${event.transaction.hash}:${event.index}`,
    block: event.block.number,
    transaction: event.transaction.hash,
    locker: event.args.locker,
    pool_key: event.args.pool_key,
    params: event.args.params,
    delta: event.args.delta,
  });
});

app.on("Core:PositionFeesCollected", async ({ event, context }) => {
  await context.db.insert(schema.positionFeesCollected).values({
    id: `${event.transaction.hash}:${event.index}`,
    block: event.block.number,
    transaction: event.transaction.hash,
    pool_key: event.args.pool_key,
    position_key: event.args.position_key,
    delta: event.args.delta,
  });
});

app.on("Core:Swapped", async ({ event, context }) => {
  await context.db.insert(schema.swapped).values({
    id: `${event.transaction.hash}:${event.index}`,
    block: event.block.number,
    transaction: event.transaction.hash,
    locker: event.args.locker,
    pool_key: event.args.pool_key,
    params: event.args.params,
    delta: event.args.delta,
    sqrt_ratio_after: event.args.sqrt_ratio_after,
    tick_after: event.args.tick_after,
    liquidity_after: event.args.liquidity_after,
  });
});

app.on("Core:SavedBalance", async ({ event, context }) => {
  await context.db.insert(schema.savedBalance).values({
    id: `${event.transaction.hash}:${event.index}`,
    block: event.block.number,
    transaction: event.transaction.hash,
    key: event.args.key,
    amount: event.args.amount,
  });
});

app.on("Core:LoadedBalance", async ({ event, context }) => {
  await context.db.insert(schema.loadedBalance).values({
    id: `${event.transaction.hash}:${event.index}`,
    block: event.block.number,
    transaction: event.transaction.hash,
    key: event.args.key,
    amount: event.args.amount,
  });
});

app.on("Core:FeesAccumulated", async ({ event, context }) => {
  await context.db.insert(schema.feesAccumulated).values({
    id: `${event.transaction.hash}:${event.index}`,
    block: event.block.number,
    transaction: event.transaction.hash,
    pool_key: event.args.pool_key,
    amount0: event.args.amount0,
    amount1: event.args.amount1,
  });
});

app.on("Core:ExtensionCallPointsSet", async ({ event, context }) => {
  await context.db.insert(schema.extensionCallPointsSet).values({
    id: `${event.transaction.hash}:${event.index}`,
    block: event.block.number,
    transaction: event.transaction.hash,
    extension: event.args.extension,
    call_points: event.args.call_points,
  });
});
