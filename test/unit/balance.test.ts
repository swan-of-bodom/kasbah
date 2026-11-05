import { expect, test, vi } from "vitest";
import { endpointsOf, loadBalance } from "../../src/config/rpc.ts";
import { RpcClient } from "../../src/rpc/client.ts";

type Body = { id: number; method: string; params: { filter?: { continuation_token?: string } } };

/** Fake nodes by URL: `answer` gets the node's name and a call, and returns its result (or throws a status). */
function nodes(answer: (node: string, c: Body) => unknown) {
  const seen: { node: string; c: Body }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const node = new URL(url).host;
    const body = JSON.parse(init.body as string) as Body | Body[];
    const calls = [body].flat();
    try {
      const out = calls.map((c) => {
        seen.push({ node, c });
        return { jsonrpc: "2.0", id: c.id, result: answer(node, c) };
      });
      return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]));
    } catch (status) {
      return new Response("down", { status: status as number });
    }
  }) as unknown as typeof globalThis.fetch;
  return { seen, fetch };
}

test("load balancing: a capped endpoint takes its share, the other the rest", async () => {
  const n = nodes(() => "0x1");
  const rpc = new RpcClient([{ url: "http://a", maxRequestsPerSecond: 10 }, { url: "http://b" }], {
    fetch: n.fetch,
  });
  await Promise.all(Array.from({ length: 60 }, () => rpc.request("starknet_blockNumber", [])));
  const [a, b] = rpc.endpoints;
  expect(a!.calls + b!.calls).toBe(60);
  expect(a!.calls).toBeGreaterThan(0);
  expect(a!.calls).toBeLessThanOrEqual(12);
  expect(rpc.rate).toBe(10 + 100);
});

test("load balancing: a failing endpoint's call is retried on another", async () => {
  const n = nodes((node) => {
    if (node === "a") throw 503;
    return "0x1";
  });
  const rpc = new RpcClient(loadBalance(["http://a", "http://b"]) as string[], { fetch: n.fetch });
  // Off the random pick (`PICK.explore`), so the first call goes to a, the first in order.
  const random = vi.spyOn(Math, "random").mockReturnValue(0.99);
  try {
    expect(await rpc.request("starknet_blockNumber", [])).toBe("0x1");
  } finally {
    random.mockRestore();
  }
  const [a, b] = rpc.endpoints;
  expect(a!.failed).toBe(1);
  expect(b!.calls).toBe(1);
});

test("load balancing: a getEvents page goes to the node that issued its continuation token", async () => {
  const n = nodes((node, c) => {
    const token = c.params.filter?.continuation_token;
    if (token !== undefined && !token.startsWith(node)) throw 400;
    const page = token === undefined ? 0 : Number(token.split("-")[1]);
    return { events: [], continuation_token: page < 5 ? `${node}-${page + 1}` : undefined };
  });
  const rpc = new RpcClient(["http://a", "http://b"], { fetch: n.fetch });
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      let token: string | undefined;
      do {
        const page = await rpc.request<{ continuation_token?: string }>("starknet_getEvents", {
          filter: { continuation_token: token },
        });
        token = page.continuation_token;
      } while (token !== undefined);
    }),
  );
  for (const { node, c } of n.seen) {
    const token = c.params.filter?.continuation_token;
    if (token !== undefined) expect(token.startsWith(node)).toBe(true);
  }
  expect(new Set(n.seen.map((s) => s.node)).size).toBe(2);
});

test("requestEach asks every endpoint, in order", async () => {
  const n = nodes((node) => `0x${node === "a" ? 1 : 2}`);
  const rpc = new RpcClient(["http://a", "http://b"], { fetch: n.fetch });
  expect(await rpc.requestEach("starknet_chainId", [])).toEqual(["0x1", "0x2"]);
});

test("rpc config: one URL, a capped one, or several; refused when not a URL", () => {
  expect(endpointsOf("https://x")).toEqual([{ url: "https://x" }]);
  expect(endpointsOf({ url: "https://x", maxRequestsPerSecond: 5 })).toEqual([
    { url: "https://x", maxRequestsPerSecond: 5 },
  ]);
  expect(endpointsOf(loadBalance(["https://x", { url: "https://y" }]))).toHaveLength(2);
  expect(() => endpointsOf("")).toThrow("is not an http(s) URL");
  expect(() => endpointsOf([])).toThrow("no URL");
  expect(() => endpointsOf({ url: "https://x", maxRequestsPerSecond: 0 })).toThrow("above 0");
});
