import oracleAbi from "../abis/Oracle.ts";
import app from "../kasbah.config.ts";
import { price } from "../kasbah.schema.ts";

const ORACLE = "0x02a85bd616f912537c50a49a4076db02c00b29b2cdc8a197ce92ed1837fa875b";
const PAIRS = ["ETH/USD", "BTC/USD", "STRK/USD"];

/** A Pragma pair id: the pair's name as a Cairo short string (its ASCII bytes as one felt). */
const pairId = (name: string) => BigInt(`0x${Buffer.from(name, "ascii").toString("hex")}`);

app.on("Prices:block", async ({ event, context }) => {
  // One round trip for all pairs, at the end of this block; final blocks' answers are cached.
  const answers = await context.client.readContracts({
    contracts: PAIRS.map((pair) => ({
      abi: oracleAbi,
      address: ORACLE,
      functionName: "get_data_median" as const,
      args: { data_type: { variant: "SpotEntry" as const, value: pairId(pair) } },
    })),
  });
  for (const [i, answer] of answers.entries()) {
    // A pair the oracle doesn't have yet at this block fails: skip it.
    if (answer.status === "failure") continue;
    const r = answer.result;
    await context.db.insert(price).values({
      pair: PAIRS[i]!,
      block: event.block.number,
      timestamp: event.block.timestamp,
      price: r.price,
      decimals: r.decimals,
      value: Number(r.price) / 10 ** r.decimals,
      updatedAt: Number(r.last_updated_timestamp),
      sources: r.num_sources_aggregated,
    });
  }
});
