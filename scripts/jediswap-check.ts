// Compares every indexed pair with the chain at the checkpoint: reserves from `get_reserves`, tokens from
// `token0`/`token1`, both through the proxy (whose ABI is the implementation's).
//   DATABASE_SCHEMA=<the jediswap template's schema> node --env-file=.env --no-warnings scripts/jediswap-check.ts
import pg from "pg";
import { CallClient } from "../src/indexer/client.ts";
import { RpcClient } from "../src/rpc/client.ts";
import pairAbi from "../templates/jediswap/abis/Pair.ts";

const schema = process.env.DATABASE_SCHEMA ?? "jediswap";
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const block = Number(
  (await db.query(`SELECT value FROM "${schema}"._kasbah_meta WHERE key = 'checkpoint'`)).rows[0]
    .value,
);
const rows = (
  await db.query(
    `SELECT address, token0, token1, reserve0::text, reserve1::text, swap_count AS swaps FROM "${schema}".pair`,
  )
).rows;
const client = new CallClient(new RpcClient(process.env.KASBAH_RPC_URL!), {
  isFinal: () => false,
});
const n = (h: string) => BigInt(h);

let mismatched = 0;
await Promise.all(
  rows.map(async (p) => {
    const [r, t0, t1] = await client.readContracts({
      contracts: [
        { abi: pairAbi, address: p.address, functionName: "get_reserves" },
        { abi: pairAbi, address: p.address, functionName: "token0" },
        { abi: pairAbi, address: p.address, functionName: "token1" },
      ],
      allowFailure: false,
      block,
    });
    const ok =
      r.reserve0 === BigInt(p.reserve0) &&
      r.reserve1 === BigInt(p.reserve1) &&
      t0.address === n(p.token0) &&
      t1.address === n(p.token1);
    if (!ok) {
      mismatched++;
      console.log(
        `${p.address}: indexed ${p.reserve0}/${p.reserve1}, chain ${r.reserve0}/${r.reserve1}`,
      );
    }
  }),
);
const swaps = rows.reduce((s, p) => s + p.swaps, 0);
console.log(
  `block ${block}: ${rows.length} pairs, ${swaps} swaps, ${mismatched} mismatched, ${client.stats.calls} calls`,
);
await db.end();
