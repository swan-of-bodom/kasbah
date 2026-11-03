import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RpcClient } from "../../src/rpc/client.ts";
import { sleep } from "../../src/utils/sleep.ts";

/** A node answering through `fetch`: `answer` gives the HTTP status (or a JSON-RPC error code) per request. */
function fakeNode(answer: (n: number) => number | { code: number }) {
  const at: number[] = [];
  const fetch = (async (_: unknown, init: RequestInit) => {
    at.push(Date.now());
    const a = answer(at.length);
    const call = JSON.parse(init.body as string) as { id: number };
    if (typeof a === "number" && a !== 200) return new Response("no", { status: a });
    const body =
      typeof a === "number"
        ? { jsonrpc: "2.0", id: call.id, result: "ok" }
        : { jsonrpc: "2.0", id: call.id, error: { code: a.code, message: "x" } };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof globalThis.fetch;
  return { fetch, at };
}

/** Request times relative to the first. */
const gaps = (at: number[]) => at.slice(1).map((t, i) => t - at[i]!);

beforeEach(() => {
  vi.useFakeTimers();
  // Backoff jitter is 0.5–1.5×: fixed at 1× here.
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("failed requests back off 200 ms, doubling per attempt", async () => {
  const node = fakeNode((n) => (n <= 3 ? 503 : 200));
  const rpc = new RpcClient("http://node", { fetch: node.fetch });
  const answer = rpc.request("m", []);
  await vi.runAllTimersAsync();
  expect(await answer).toBe("ok");
  expect(gaps(node.at)).toEqual([200, 400, 800]);
  expect(rpc.stats).toMatchObject({ retries: 3, failed: 3, throttled: 0 });
});

test("the backoff stops growing at 10 s, and the last attempt's failure is the error", async () => {
  const node = fakeNode(() => 500);
  const rpc = new RpcClient("http://node", { fetch: node.fetch, maxAttempts: 9 });
  const failed = expect(rpc.request("m", [])).rejects.toThrow("HTTP 500");
  await vi.runAllTimersAsync();
  await failed;
  expect(gaps(node.at)).toEqual([200, 400, 800, 1_600, 3_200, 6_400, 10_000, 10_000]);
});

test("a call error that retrying can't fix fails at once, with no backoff", async () => {
  const node = fakeNode(() => ({ code: 29 }));
  const rpc = new RpcClient("http://node", { fetch: node.fetch });
  const failed = expect(rpc.request("m", [])).rejects.toThrow("29 x");
  await vi.runAllTimersAsync();
  await failed;
  expect(node.at).toHaveLength(1);
});

test("throttles never use up attempts: they pause sending, longer each time in a row, and lower the rate", async () => {
  const node = fakeNode((n) => (n <= 5 ? 429 : 200));
  const rpc = new RpcClient("http://node", { fetch: node.fetch, maxAttempts: 1 });
  const answer = rpc.request("m", []);
  await vi.runAllTimersAsync();
  expect(await answer).toBe("ok");
  expect(rpc.stats).toMatchObject({ throttled: 5, failed: 0 });
  const g = gaps(node.at);
  for (let i = 1; i < g.length; i++) expect(g[i]).toBeGreaterThan(g[i - 1]!);
  expect(g[0]).toBeGreaterThanOrEqual(100);
  expect(rpc.rate).toBeLessThan(100);
});

test("calls are paced at the starting rate: a second's worth at once, the rest as tokens refill", async () => {
  const node = fakeNode(() => 200);
  const rpc = new RpcClient("http://node", { fetch: node.fetch, initialRate: 10 });
  const answers = Promise.all(Array.from({ length: 30 }, () => rpc.request("m", [])));
  await vi.runAllTimersAsync();
  await answers;
  expect(node.at.filter((t) => t === node.at[0]).length).toBe(10);
  expect(node.at.at(-1)! - node.at[0]!).toBeGreaterThan(0);
});

test("an endpoint's time to headers leaves out reading the body; its latency doesn't", async () => {
  const fetch = (async (_: unknown, init: RequestInit) => {
    const { id } = JSON.parse(init.body as string) as { id: number };
    await sleep(300);
    const text = JSON.stringify({ jsonrpc: "2.0", id, result: "ok" });
    const body = new ReadableStream({
      async pull(c) {
        await sleep(500);
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof globalThis.fetch;
  const rpc = new RpcClient("http://node", { fetch });
  const done = rpc.request("starknet_chainId", []);
  await vi.advanceTimersByTimeAsync(1000);
  await done;
  expect(rpc.endpoints[0]).toMatchObject({ headersMs: 300, latencyMs: 800 });
});

test("sleep resolves at its time, not before", async () => {
  let done = false;
  void sleep(1_000).then(() => (done = true));
  await vi.advanceTimersByTimeAsync(999);
  expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(done).toBe(true);
});
