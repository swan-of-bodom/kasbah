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

test("zstd responses decode whether or not fetch already decoded them", async () => {
  const { zstdCompressSync } = await import("node:zlib");
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "zstd" });
      res.end(zstdCompressSync(JSON.stringify({ jsonrpc: "2.0", id: 0, result: "x".repeat(1_000) })));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const rpc = new RpcClient(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    expect(await rpc.request("m", [])).toBe("x".repeat(1_000));
  } finally {
    server.close();
  }
});

test("paced to what the endpoint takes: a few throttles while finding the rate, then none", async () => {
  const LIMIT = 1_000;
  const window: { at: number; n: number }[] = [];
  let rejected = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const calls = [JSON.parse(body)].flat();
      const now = Date.now();
      while (window.length > 0 && window[0]!.at <= now - 1_000) window.shift();
      if (window.reduce((a, w) => a + w.n, 0) + calls.length > LIMIT) {
        rejected++;
        res.writeHead(429).end("compute units per second exceeded");
        return;
      }
      window.push({ at: now, n: calls.length });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: c.params.n }))));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const rpc = new RpcClient(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    const send = (from: number, count: number) =>
      Promise.all(Array.from({ length: count / 100 }, (_, b) => rpc.batch(Array.from({ length: 100 }, (_, i) => ({ method: "m", params: { n: from + b * 100 + i } })))));
    const first = (await send(0, 3_000)).flat();
    expect(first).toEqual(Array.from({ length: 3_000 }, (_, i) => i));
    const found = rejected;
    expect(found).toBeLessThanOrEqual(5);
    expect(rpc.rate).toBeLessThanOrEqual(LIMIT);
    expect(rpc.rate).toBeGreaterThanOrEqual(LIMIT / 4);
    await send(3_000, 2_000);
    expect(rejected - found).toBeLessThanOrEqual(1);
  } finally {
    server.close();
  }
}, 30_000);

test("a batch larger than a second's worth of calls goes out in pieces", async () => {
  const n = await node((c) => c.params.n);
  try {
    const rpc = new RpcClient(n.url, { initialRate: 40 });
    const calls = Array.from({ length: 100 }, (_, i) => ({ method: "m", params: { n: String(i) } }));
    expect(await rpc.batch(calls)).toEqual(calls.map((c) => c.params.n));
    expect(n.sent.map((s) => s.length)).toEqual([40, 40, 20]);
  } finally {
    n.server.close();
  }
});
