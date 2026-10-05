import { expect, test } from "vitest";
import { WebSocketServer, type WebSocket as Socket } from "ws";
import { HeadSubscription } from "../src/sync/heads.ts";

async function server(onSubscribe: (socket: Socket, id: number) => void) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.on("listening", r));
  const sockets: Socket[] = [];
  wss.on("connection", (s) => {
    sockets.push(s);
    s.on("message", (m) => {
      const msg = JSON.parse(String(m));
      if (msg.method === "starknet_subscribeNewHeads") onSubscribe(s, msg.id);
    });
  });
  const head = (n: number) => {
    for (const s of sockets) s.send(JSON.stringify({ jsonrpc: "2.0", method: "starknet_subscriptionNewHeads", params: { subscription_id: "0x1", result: { block_number: n } } }));
  };
  return { url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`, wss, sockets, head };
}
const accept = (s: Socket, id: number) => s.send(JSON.stringify({ jsonrpc: "2.0", id, result: "0x1" }));
const until = async (c: () => boolean) => {
  for (let i = 0; i < 500 && !c(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(c()).toBe(true);
};
const timed = async (p: Promise<void>) => {
  const t = performance.now();
  await p;
  return performance.now() - t;
};

test("a head wakes a waiter, a head between waits isn't lost, reconnects after a drop", async () => {
  const s = await server(accept);
  const logs: string[] = [];
  const heads = new HeadSubscription(s.url, (l) => logs.push(l));
  const signal = new AbortController().signal;
  try {
    await until(() => heads.healthy);
    await heads.wait(10, signal); // the wake on subscribe
    const waiting = heads.wait(10_000, signal);
    s.head(1);
    expect(await timed(waiting)).toBeLessThan(1_000);

    s.head(2);
    await until(() => heads.stats.heads >= 3);
    expect(await timed(heads.wait(10_000, signal))).toBeLessThan(50);

    for (const socket of s.sockets.splice(0)) socket.terminate();
    await until(() => !heads.healthy);
    expect(await timed(heads.wait(30, signal))).toBeLessThan(500);
    await until(() => heads.healthy);
    expect(heads.stats.connects).toBe(2);
    expect(logs).toContain("WebSocket: reconnected");
  } finally {
    heads.close();
    s.wss.close();
  }
});

test("a refused subscription gives up and leaves polling", async () => {
  const s = await server((socket, id) => socket.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } })));
  const logs: string[] = [];
  const heads = new HeadSubscription(s.url, (l) => logs.push(l));
  try {
    await until(() => logs.length > 0);
    expect(logs[0]).toContain("refused (Method not found)");
    expect(heads.healthy).toBe(false);
  } finally {
    heads.close();
    s.wss.close();
  }
});
