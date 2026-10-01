import { RpcClient } from "../src/rpc/client.ts";
import { probe } from "../src/rpc/probe.ts";
import { endpoints } from "./endpoints.ts";
for (const [name, url] of Object.entries(endpoints())) {
  const rpc = new RpcClient(url, { maxAttempts: 2 });
  const t = performance.now();
  try { console.log(name, await probe(rpc), `${Math.round(performance.now() - t)}ms`); }
  catch (e) { console.log(name, "FAILED", (e as Error).message); }
}
