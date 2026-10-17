import { kasbah } from "../../src/index.ts";
import coreAbi from "./abis/Core.ts";
import * as schema from "./kasbah.schema.ts";

/** Ekubo from its deployment: pools, hourly and daily candles (price, volume, fees, TVL), protocol totals. */
export default kasbah({
  rpc: process.env.KASBAH_RPC_URL!,
  ws: true,
  database: process.env.DATABASE_URL!,
  schema: "ekubo",
  contracts: {
    Core: {
      abi: coreAbi,
      address: "0x00000005dd3d2f4429af886cd1a3b08289dbcea99a294197e9eb43b0e0325b4b",
      startBlock: 165_392,
      include: { block: true },
    },
  },
  blocks: { Snapshot: { interval: 1_800, startBlock: 165_392 } },
  tables: schema,
  api: { port: 42069 },
  cache: true,
});
