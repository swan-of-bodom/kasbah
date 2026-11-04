import app from "../kasbah.config.ts";
import { account, allowance, approvalEvent, transferEvent } from "../kasbah.schema.ts";

app.on("LORDS:Transfer", async ({ event, context }) => {
  const { from, to, value } = event.args;
  await context.db
    .insert(account)
    .values({ address: from, balance: -value })
    .onConflictDoUpdate((row) => ({ balance: row.balance - value }));
  await context.db
    .insert(account)
    .values({ address: to, balance: value })
    .onConflictDoUpdate((row) => ({ balance: row.balance + value }));
  await context.db.insert(transferEvent).values({
    id: `${event.transaction.hash}:${event.index}`,
    block: event.block.number,
    from,
    to,
    amount: value,
  });
});

app.on("LORDS:Approval", async ({ event, context }) => {
  const { owner, spender, value } = event.args;
  await context.db
    .insert(allowance)
    .values({ owner, spender, amount: value })
    .onConflictDoUpdate({ amount: value });
  await context.db.insert(approvalEvent).values({
    id: `${event.transaction.hash}:${event.index}`,
    block: event.block.number,
    owner,
    spender,
    amount: value,
  });
});
