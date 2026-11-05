import { bench, describe } from "vitest";
import { packFeltsHex } from "../../src/db/felts.ts";

const felts = Array.from({ length: 30 }, (_, i) =>
  i % 3 === 0
    ? `0x${(i + 1).toString(16)}`
    : `0x${((BigInt(i) + 1n) * 0x9e3779b97f4a7c15n * 7919n ** 10n).toString(16).slice(0, 62)}`,
);
const viaBigInt = (fs: string[]) =>
  Buffer.concat(
    fs.flatMap((f) => {
      let h = BigInt(f).toString(16);
      if (h === "0") h = "";
      else if (h.length % 2 === 1) h = `0${h}`;
      const b = Buffer.from(h, "hex");
      return [Buffer.from([b.length]), b];
    }),
  ).toString("hex");

describe("packing an event's 30 data felts for the cache COPY", () => {
  bench("through BigInt and Buffers (before)", () => {
    viaBigInt(felts);
  });
  bench("packFeltsHex", () => {
    packFeltsHex(felts);
  });
});
