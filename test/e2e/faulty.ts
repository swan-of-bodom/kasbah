import { createServer } from "node:http";

/** What the proxy can do to a request instead of passing it on unchanged. */
export type Fault = "throttle" | "unavailable" | "drop" | "truncate" | "missing";
const FAULTS: readonly Fault[] = ["throttle", "unavailable", "drop", "truncate", "missing"];

/**
 * An HTTP proxy in front of a JSON-RPC node that answers a `share` of requests with a fault: a 429, a 503, a dropped
 * connection, a body cut in half, or a batch missing its last answer. Seeded, so a run's faults repeat.
 */
export async function faultyProxy(target: string, o: { share: number; seed?: number }) {
  let s = o.seed ?? 1;
  const rand = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const injected = Object.fromEntries(FAULTS.map((f) => [f, 0])) as Record<Fault, number>;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const fault = rand() < o.share ? FAULTS[Math.floor(rand() * FAULTS.length)] : undefined;
      if (fault !== undefined) injected[fault]++;
      if (fault === "throttle") return res.writeHead(429).end("compute units per second exceeded");
      if (fault === "unavailable") return res.writeHead(503).end("upstream unavailable");
      if (fault === "drop") return req.socket.destroy();
      const upstream = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      let text = await upstream.text();
      const parsed = JSON.parse(text) as unknown;
      if (fault === "truncate" || (fault === "missing" && !Array.isArray(parsed)))
        text = text.slice(0, text.length >> 1);
      else if (fault === "missing") text = JSON.stringify((parsed as unknown[]).slice(0, -1));
      res.writeHead(200, { "content-type": "application/json" }).end(text);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, injected, close: () => server.close() };
}
