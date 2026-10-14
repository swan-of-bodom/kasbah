import { expect, test } from "vitest";
import { type RawReceipt, type RawTransaction, receiptOf, transactionOf } from "../src/transaction.ts";
import samples from "./fixtures/mainnet-transactions.json" with { type: "json" };
import { felt } from "../src/felt.ts";

const kinds = (samples as { transaction: RawTransaction; receipt: RawReceipt }[]).map((s) => ({ tx: transactionOf(s.transaction), receipt: receiptOf(s.receipt) }));
const find = (type: string, version: string, status = "SUCCEEDED") => kinds.find((k) => k.tx.type === type && k.tx.version === version && k.receipt.executionStatus === status)!;

/** Every key, however deep: none may stay snake_case. */
const keys = (v: unknown): string[] =>
  v !== null && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [...(Array.isArray(v) ? [] : [k]), ...keys(x)]) : [];

test("mainnet transactions and receipts of every kind convert, nothing left in snake_case", () => {
  expect(kinds.map((k) => `${k.tx.type} ${k.tx.version} ${k.receipt.executionStatus}`).sort()).toEqual([
    "DECLARE 0x2 SUCCEEDED",
    "DEPLOY 0x0 SUCCEEDED",
    "DEPLOY_ACCOUNT 0x1 SUCCEEDED",
    "INVOKE 0x0 SUCCEEDED",
    "INVOKE 0x1 REVERTED",
    "INVOKE 0x1 SUCCEEDED",
    "INVOKE 0x3 REVERTED",
    "INVOKE 0x3 SUCCEEDED",
    "L1_HANDLER 0x0 SUCCEEDED",
  ]);
  for (const k of kinds) expect([...keys(k.tx), ...keys(k.receipt)].filter((key) => key.includes("_"))).toEqual([]);
  for (const k of kinds) expect(k.receipt.transactionHash).toBe(k.tx.hash);
  // One form for every felt: 0x and 64 lowercase digits (version and the enums aren't felts).
  const strings = (v: unknown, key = ""): [string, string][] =>
    typeof v === "string" ? [[key, v]] : v !== null && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => strings(x, Array.isArray(v) ? key : k)) : [];
  const notFelts = new Set(["type", "version", "nonceDataAvailabilityMode", "feeDataAvailabilityMode", "unit", "executionStatus", "revertReason"]);
  for (const k of kinds) for (const [key, s] of [...strings(k.tx), ...strings(k.receipt)]) if (!notFelts.has(key)) expect(s, key).toMatch(/^0x[0-9a-f]{64}$/);
});

test("amounts, fees and nonces are bigints; per-type fields are there", () => {
  const v3 = find("INVOKE", "0x3").tx;
  if (v3.type !== "INVOKE" || v3.version !== "0x3") throw new Error("narrowing");
  expect(v3.nonce).toBe(0x37n);
  expect(v3.tip).toBe(0n);
  expect(v3.resourceBounds.l1Gas).toEqual({ maxAmount: 0x1054n, maxPricePerUnit: 0xcceb80dc65aan });
  expect(v3.nonceDataAvailabilityMode).toMatch(/^L[12]$/);
  expect(Array.isArray(v3.paymasterData) && Array.isArray(v3.accountDeploymentData)).toBe(true);

  const v1 = find("INVOKE", "0x1").tx;
  expect(v1).toMatchObject({ maxFee: 0xc72de934b000n, nonce: 0x3dn });
  expect(v1).not.toHaveProperty("resourceBounds");
  expect(find("INVOKE", "0x0").tx).toMatchObject({ maxFee: 0n, contractAddress: expect.stringMatching(/^0x/), entryPointSelector: expect.stringMatching(/^0x/) });

  const l1 = find("L1_HANDLER", "0x0");
  expect(l1.tx).toMatchObject({ nonce: 0x1590c9n });
  expect(l1.tx).not.toHaveProperty("signature");
  expect(l1.receipt).toMatchObject({ type: "L1_HANDLER", messageHash: felt("0x7f256b9f80693f0369cedd8f752d199979d224bf28b5c5d8349dbdd1b1855527") });

  expect(find("DEPLOY_ACCOUNT", "0x1").receipt).toMatchObject({ contractAddress: felt("0x649fb82b3109ab54ae19651e296ed0bbbcd8aee29ea3c9c79a93a57813c180a") });
  expect(find("DEPLOY", "0x0").tx).toMatchObject({ classHash: expect.stringMatching(/^0x/), constructorCalldata: expect.any(Array) });
  expect(find("DECLARE", "0x2").tx).toMatchObject({ maxFee: 0x21a0475deff4n, nonce: 0x11n, compiledClassHash: expect.stringMatching(/^0x/) });

  const reverted = find("INVOKE", "0x3", "REVERTED").receipt;
  if (reverted.executionStatus !== "REVERTED") throw new Error("narrowing");
  expect(reverted.revertReason.length).toBeGreaterThan(0);
  expect(reverted.actualFee).toEqual({ amount: 0x460368c116959d4n, unit: "FRI" });
  expect(find("INVOKE", "0x3").receipt).not.toHaveProperty("revertReason");
  expect(find("INVOKE", "0x3").receipt.executionResources).toEqual({ l1Gas: 0, l1DataGas: 0, l2Gas: 0 });
  // Status changes as the block settles: not kept.
  for (const k of kinds) expect(k.receipt).not.toHaveProperty("finalityStatus");
});

test("the kinds too rare to sample, built from the spec: DECLARE v0, v1, v3 and DEPLOY_ACCOUNT v3", () => {
  const b = { max_amount: "0x2", max_price_per_unit: "0x3" };
  const v3 = { resource_bounds: { l1_gas: b, l1_data_gas: b, l2_gas: b }, tip: "0x4", paymaster_data: [], nonce_data_availability_mode: "L1", fee_data_availability_mode: "L2" };
  const common = { transaction_hash: "0xa", signature: ["0x1"], class_hash: "0xc1" };
  expect(transactionOf({ ...common, type: "DECLARE", version: "0x0", sender_address: "0x5", max_fee: "0x9" })).toEqual({ hash: felt("0xa"), type: "DECLARE", version: "0x0", signature: [felt("0x1")], classHash: felt("0xc1"), senderAddress: felt("0x5"), maxFee: 9n });
  expect(transactionOf({ ...common, type: "DECLARE", version: "0x1", sender_address: "0x5", max_fee: "0x9", nonce: "0x7" })).toMatchObject({ nonce: 7n, maxFee: 9n });
  expect(transactionOf({ ...common, ...v3, type: "DECLARE", version: "0x3", sender_address: "0x5", nonce: "0x7", compiled_class_hash: "0xcc", account_deployment_data: [] })).toEqual({
    hash: felt("0xa"), type: "DECLARE", version: "0x3", signature: [felt("0x1")], classHash: felt("0xc1"), senderAddress: felt("0x5"), nonce: 7n, compiledClassHash: felt("0xcc"), accountDeploymentData: [],
    resourceBounds: { l1Gas: { maxAmount: 2n, maxPricePerUnit: 3n }, l1DataGas: { maxAmount: 2n, maxPricePerUnit: 3n }, l2Gas: { maxAmount: 2n, maxPricePerUnit: 3n } },
    tip: 4n, paymasterData: [], nonceDataAvailabilityMode: "L1", feeDataAvailabilityMode: "L2",
  });
  expect(transactionOf({ ...common, ...v3, type: "DEPLOY_ACCOUNT", version: "0x3", nonce: "0x0", contract_address_salt: "0x5a", constructor_calldata: ["0x1"] })).toMatchObject({
    type: "DEPLOY_ACCOUNT", version: "0x3", nonce: 0n, contractAddressSalt: felt("0x5a"), constructorCalldata: [felt("0x1")], tip: 4n,
  });
});
