const bounds = { max_amount: "0x0", max_price_per_unit: "0x0" };

/** A spec-complete INVOKE v3, as `starknet_getTransactionByHash` returns it. */
export const invokeV3 = (hash: string, sender: string) => ({
  transaction_hash: hash,
  type: "INVOKE",
  version: "0x3",
  sender_address: sender,
  calldata: [],
  signature: [],
  nonce: "0x1",
  resource_bounds: { l1_gas: bounds, l1_data_gas: bounds, l2_gas: { max_amount: "0x10", max_price_per_unit: "0x20" } },
  tip: "0x0",
  paymaster_data: [],
  account_deployment_data: [],
  nonce_data_availability_mode: "L1",
  fee_data_availability_mode: "L1",
});

/** Its receipt, as `starknet_getTransactionReceipt` returns it. */
export const invokeReceipt = (hash: string, block: { number: number; hash: string }, fee: string, events: { from_address: string; keys: string[]; data: string[] }[]) => ({
  transaction_hash: hash,
  type: "INVOKE",
  actual_fee: { amount: fee, unit: "FRI" },
  execution_status: "SUCCEEDED",
  finality_status: "ACCEPTED_ON_L2",
  events: events.map((e) => ({ from_address: e.from_address, keys: e.keys, data: e.data })),
  messages_sent: [],
  execution_resources: { l1_gas: 0, l1_data_gas: 128, l2_gas: 1_000 },
  block_hash: block.hash,
  block_number: block.number,
});
