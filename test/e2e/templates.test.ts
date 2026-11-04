import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join, resolve } from "node:path";
import pg from "pg";
import { afterAll, expect, test } from "vitest";
import { selector } from "../../src/abi/selector.ts";
import { load } from "../../src/cli/project.ts";
import { felt } from "../../src/types/felt.ts";
import { eventNode } from "../fixtures/counter.ts";

const url = process.env.DATABASE_URL;
const dir = mkdtempSync(join(resolve("test"), ".tmp-templates-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function listen(server: Server) {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/**
 * The template in a directory of its own, without its config's `network`: the fake node is on a test chain, so its
 * events never reach a real chain's cache.
 */
function copy(template: string): string {
  const to = join(dir, template);
  cpSync(resolve("templates", template), to, { recursive: true });
  const config = join(to, "kasbah.config.ts");
  const text = readFileSync(config, "utf8");
  expect(text).toContain(`  network: "mainnet",\n`);
  writeFileSync(config, text.replace(`  network: "mainnet",\n`, ""));
  return to;
}

const LORDS = "0x0124aeb495b947201f5fac96fd1138e326ad86195b98df6dec9009158a533b49";
const START = 88_597;
const [ZERO, A, B, S] = ["0x0", "0xa11ce", "0xb0b", "0x5bed"];
const u256 = (v: bigint) => [`0x${v.toString(16)}`, "0x0"];
const transfer = (block: number, from: string, to: string, value: bigint) => ({
  address: LORDS,
  block,
  keys: [selector("Transfer")],
  data: [from, to, ...u256(value)],
});
const approval = (block: number, owner: string, spender: string, value: bigint) => ({
  address: LORDS,
  block,
  keys: [selector("Approval")],
  data: [owner, spender, ...u256(value)],
});

test.skipIf(url === undefined)(
  "the erc20 template keeps balances and allowances, and its GraphQL follows the relations both ways",
  async () => {
    const abi = (await import("../../templates/erc20/abis/ERC20.ts")).default;
    const node = eventNode(
      START + 100,
      [
        transfer(START + 3, ZERO, A, 100n),
        transfer(START + 4, A, B, 30n),
        approval(START + 4, A, S, 50n),
        approval(START + 6, A, S, 20n),
        transfer(START + 6, A, B, 10n),
      ],
      { abi },
    );
    const schema = "kasbah_test_template_erc20";
    process.env.KASBAH_RPC_URL = await listen(node);
    process.env.DATABASE_SCHEMA = schema;
    process.env.PORT = "0";
    const app = await load(join(copy("erc20"), "kasbah.config.ts"));
    let api: { url: string; close: () => Promise<void> } | undefined;
    try {
      await app.run({ reset: true, to: START + 8, status: undefined });
      api = await app.serve();
      const query = async (q: string) => {
        const r = await fetch(`${api!.url}/graphql`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: q }),
        });
        return ((await r.json()) as { data: unknown }).data;
      };
      expect(
        await query(`{
          account(address: "${felt(A)}") {
            balance
            transfersFrom(orderBy: "block") { items { amount toAccount { address balance } } }
            approvals { totalCount }
          }
          allowances { items { owner spender amount } }
        }`),
      ).toEqual({
        account: {
          balance: "60",
          transfersFrom: {
            items: [
              { amount: "30", toAccount: { address: felt(B), balance: "40" } },
              { amount: "10", toAccount: { address: felt(B), balance: "40" } },
            ],
          },
          approvals: { totalCount: 2 },
        },
        allowances: { items: [{ owner: felt(A), spender: felt(S), amount: "20" }] },
      });
      expect(await query(`{ account(address: "${felt(ZERO)}") { balance } }`)).toEqual({
        account: { balance: "-100" },
      });
      expect(await (await fetch(`${api.url}/balance/${A}`)).json()).toEqual({
        address: felt(A),
        balance: "60",
      });
      expect((await fetch(`${api.url}/balance/nope`)).status).toBe(400);
      expect(
        ((await (await fetch(`${api.url}/holders?limit=2`)).json()) as { address: string }[]).map(
          (h) => h.address,
        ),
      ).toEqual([felt(A), felt(B)]);
    } finally {
      await api?.close();
      node.close();
      delete process.env.DATABASE_SCHEMA;
      delete process.env.PORT;
      const p = new pg.Pool({ connectionString: url, max: 1 });
      await p.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await p.end();
    }
  },
);
