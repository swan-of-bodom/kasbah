import { bignum, hex, index, integer, pgTable, primaryKey, relations, text } from "kasbah";

/** Every address that sent or received LORDS. The zero address mints, so its balance is minus the supply. */
export const account = pgTable("account", {
  address: hex().primaryKey(),
  balance: bignum().notNull(),
});

export const accountRelations = relations(account, ({ many }) => ({
  transfersFrom: many(transferEvent, { relationName: "from_account" }),
  transfersTo: many(transferEvent, { relationName: "to_account" }),
  approvals: many(approvalEvent),
}));

export const transferEvent = pgTable(
  "transfer_event",
  {
    id: text().primaryKey(),
    block: integer().notNull(),
    from: hex().notNull(),
    to: hex().notNull(),
    amount: bignum().notNull(),
  },
  (t) => [index().on(t.from), index().on(t.to)],
);

export const transferEventRelations = relations(transferEvent, ({ one }) => ({
  fromAccount: one(account, {
    relationName: "from_account",
    fields: [transferEvent.from],
    references: [account.address],
  }),
  toAccount: one(account, {
    relationName: "to_account",
    fields: [transferEvent.to],
    references: [account.address],
  }),
}));

/** What `spender` may still move from `owner`'s balance, as last approved. */
export const allowance = pgTable(
  "allowance",
  {
    owner: hex().notNull(),
    spender: hex().notNull(),
    amount: bignum().notNull(),
  },
  (t) => [primaryKey({ columns: [t.owner, t.spender] })],
);

export const approvalEvent = pgTable(
  "approval_event",
  {
    id: text().primaryKey(),
    block: integer().notNull(),
    owner: hex().notNull(),
    spender: hex().notNull(),
    amount: bignum().notNull(),
  },
  (t) => [index().on(t.owner)],
);

export const approvalEventRelations = relations(approvalEvent, ({ one }) => ({
  ownerAccount: one(account, { fields: [approvalEvent.owner], references: [account.address] }),
}));
