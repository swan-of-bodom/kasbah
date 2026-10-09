import { createServer } from "node:http";
import { expect, test } from "vitest";
import { RpcClient } from "../src/rpc/client.ts";

async function node(answer: (call: { id: number; method: string; params: any }, seen: number) => unknown) {
  const seen = new Map<string, number>();
  const sent: string[][] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const calls = [JSON.parse(body)].flat();
      sent.push(calls.map((c) => c.params.n));
      const out = calls.map((c) => {
        const n = (seen.get(c.params.n) ?? 0) + 1;
        seen.set(c.params.n, n);
        const r = answer(c, n) as { error?: unknown };
        return r !== null && typeof r === "object" && "error" in r ? { jsonrpc: "2.0", id: c.id, error: r.error } : { jsonrpc: "2.0", id: c.id, result: r };
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(JSON.parse(body)) ? out : out[0]));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server, sent };
}

test("throttled calls inside a batch are retried alone, the rest kept", async () => {
  const n = await node((c, seen) => (Number(c.params.n) % 3 === 0 && seen === 1 ? { error: { code: 429, message: "compute units exceeded" } } : `r${c.params.n}`));
  try {
    const rpc = new RpcClient(n.url);
    const calls = Array.from({ length: 10 }, (_, i) => ({ method: "m", params: { n: String(i) } }));
    expect(await rpc.batch(calls)).toEqual(calls.map((c) => `r${c.params.n}`));
    expect(n.sent).toEqual([calls.map((c) => c.params.n), ["0", "3", "6", "9"]]);
    expect(rpc.stats.throttled).toBe(1);
    // Billed per call: the 4 retried ones count again.
    expect(rpc.stats.methods).toEqual({ m: 14 });
  } finally {
    n.server.close();
  }
});

test("a call error that retrying can't fix rejects at once", async () => {
  const n = await node((c) => (c.params.n === "1" ? { error: { code: 29, message: "Transaction hash not found" } } : "ok"));
  try {
    const rpc = new RpcClient(n.url);
    await expect(rpc.batch([{ method: "m", params: { n: "0" } }, { method: "m", params: { n: "1" } }])).rejects.toThrow("29 Transaction hash not found");
    expect(n.sent).toHaveLength(1);
  } finally {
    n.server.close();
  }
});
