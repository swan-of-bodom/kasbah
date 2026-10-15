import type { EventCache } from "../db/cache.ts";
import type { RpcClient } from "../rpc/client.ts";
import type { EmittedEvent } from "../rpc/methods.ts";
import { type RawReceipt, type RawTransaction, type Receipt, receiptOf, type Transaction, transactionOf } from "../types/transaction.ts";

export type Extras = { transaction?: Transaction; receipt?: Receipt };
/** As the node returns them: what the cache keeps. */
export type RawExtras = { transaction?: RawTransaction; receipt?: RawReceipt };
/** `block`: the block's header (one per block with such events; free when live). */
export type Include = { transaction?: boolean; receipt?: boolean; block?: boolean };

/**
 * Transactions and receipts of the events whose contract asks for them, one request per hash (batched by 100),
 * each hash once. Final blocks go through the cache when it's on.
 */
export async function fetchExtras(
  rpc: RpcClient,
  events: EmittedEvent[],
  includeOf: (e: EmittedEvent) => Include | undefined,
  o: { cache?: EventCache; isFinal: (block: number) => boolean },
): Promise<Map<string, Extras>> {
  const wanted = new Map<string, { block: number; transaction: boolean; receipt: boolean }>();
  for (const e of events) {
    const inc = includeOf(e);
    if (inc === undefined || (!inc.transaction && !inc.receipt)) continue;
    const w = wanted.get(e.transaction_hash) ?? { block: e.block_number!, transaction: false, receipt: false };
    w.transaction ||= inc.transaction === true;
    w.receipt ||= inc.receipt === true;
    wanted.set(e.transaction_hash, w);
  }
  const out = new Map<string, RawExtras>();
  if (wanted.size === 0) return new Map();

  const final = [...wanted].filter(([, w]) => o.isFinal(w.block)).map(([h]) => h);
  if (o.cache !== undefined && final.length > 0) for (const [h, x] of await o.cache.transactions(final)) out.set(h, x);

  const calls: { hash: string; kind: "transaction" | "receipt" }[] = [];
  for (const [hash, w] of wanted) {
    const have = out.get(hash);
    if (w.transaction && have?.transaction === undefined) calls.push({ hash, kind: "transaction" });
    if (w.receipt && have?.receipt === undefined) calls.push({ hash, kind: "receipt" });
  }
  const fetched = new Map<string, RawExtras>();
  await Promise.all(
    Array.from({ length: Math.ceil(calls.length / 100) }, async (_, i) => {
      const chunk = calls.slice(i * 100, i * 100 + 100);
      const results = await rpc.batch<unknown[]>(chunk.map((c) => ({
        method: c.kind === "transaction" ? "starknet_getTransactionByHash" : "starknet_getTransactionReceipt",
        params: { transaction_hash: c.hash },
      })));
      chunk.forEach((c, j) => {
        const x = fetched.get(c.hash) ?? {};
        if (c.kind === "transaction") x.transaction = results[j] as RawTransaction;
        else x.receipt = results[j] as RawReceipt;
        fetched.set(c.hash, x);
      });
    }),
  );
  for (const [hash, x] of fetched) {
    out.set(hash, { ...out.get(hash), ...x });
    const block = wanted.get(hash)!.block;
    if (o.isFinal(block)) o.cache?.rememberTransaction(hash, block, x);
  }
  // Converted once per transaction, however many of its events are handled.
  return new Map(
    [...out].map(([hash, x]) => [hash, { transaction: x.transaction && transactionOf(x.transaction), receipt: x.receipt && receiptOf(x.receipt) }]),
  );
}
