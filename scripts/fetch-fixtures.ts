// Fetches real ABIs and events from mainnet into test/fixtures. Run: pnpm fixtures (needs KASBAH_RPC_URL in .env).
import { mkdirSync, writeFileSync } from "node:fs";
import { selector } from "../src/abi/selector.ts";

const url = process.env.KASBAH_RPC_URL;
if (!url) throw new Error("KASBAH_RPC_URL is not set");
const dir = new URL("../test/fixtures/", import.meta.url);
mkdirSync(dir, { recursive: true });

type EmittedEvent = {
  from_address: string;
  keys: string[];
  data: string[];
  block_number: number;
  transaction_hash: string;
  transaction_index: number;
  event_index: number;
};

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(url!, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: unknown };
  if (body.error !== undefined) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result as T;
}

async function getClassAt(address: string, block: number | "latest") {
  const blockId = block === "latest" ? "latest" : { block_number: block };
  const cls = await rpc<{ abi: unknown; program?: unknown }>("starknet_getClassAt", {
    block_id: blockId,
    contract_address: address,
  });
  const abi = typeof cls.abi === "string" ? JSON.parse(cls.abi) : cls.abi;
  return { abi: abi as Record<string, unknown>[], cairo0: cls.program !== undefined };
}

async function getEvents(filter: Record<string, unknown>, limit: number): Promise<EmittedEvent[]> {
  const events: EmittedEvent[] = [];
  let token: string | undefined;
  do {
    const page = await rpc<{ events: EmittedEvent[]; continuation_token?: string }>("starknet_getEvents", {
      filter: { ...filter, chunk_size: 1024, ...(token ? { continuation_token: token } : {}) },
    });
    events.push(...page.events);
    token = page.continuation_token;
  } while (token && events.length < limit);
  return events.slice(0, limit);
}

function save(name: string, abi: unknown, events: EmittedEvent[]) {
  writeFileSync(new URL(`${name}.abi.json`, dir), `${JSON.stringify(abi, null, 1)}\n`);
  writeFileSync(new URL(`${name}.abi.ts`, dir), `export default ${JSON.stringify(abi, null, 1)} as const;\n`);
  writeFileSync(new URL(`${name}.events.json`, dir), `${JSON.stringify(events, null, 1)}\n`);
  console.log(`${name}: ${abi instanceof Array ? abi.length : 0} abi items, ${events.length} events`);
}

const head = await rpc<number>("starknet_blockNumber", []);

const EKUBO_CORE = "0x00000005dd3d2f4429af886cd1a3b08289dbcea99a294197e9eb43b0e0325b4b";
{
  const { abi } = await getClassAt(EKUBO_CORE, "latest");
  const recent = await getEvents(
    { address: EKUBO_CORE, from_block: { block_number: head - 2000 }, to_block: { block_number: head } },
    400,
  );
  // A nested (non-flat) component variant: keys = [sn_keccak("OwnedEvent"), sn_keccak("OwnershipTransferred")].
  const owned = await getEvents(
    {
      address: EKUBO_CORE,
      keys: [[selector("OwnedEvent")]],
      from_block: { block_number: 0 },
      to_block: { block_number: head },
    },
    5,
  );
  save("ekubo-core", abi, [...owned, ...recent]);
}

const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
{
  const { abi } = await getClassAt(STRK, "latest");
  const events = await getEvents(
    { address: STRK, from_block: { block_number: head - 30 }, to_block: { block_number: head } },
    300,
  );
  save("strk", abi, events);
}

// Cairo 0: early mainnet emitters whose own (non-proxy) ABI declares the event they emit.
{
  const from = 30_000;
  const events = await getEvents({ from_block: { block_number: from }, to_block: { block_number: from + 200 } }, 5000);
  const byAddress = new Map<string, EmittedEvent[]>();
  for (const e of events) byAddress.set(e.from_address, [...(byAddress.get(e.from_address) ?? []), e]);
  const ranked = [...byAddress].sort((a, b) => b[1].length - a[1].length);
  let found = 0;
  for (const [address, emitted] of ranked) {
    const { abi, cairo0 } = await getClassAt(address, emitted[0]!.block_number);
    if (!cairo0) continue;
    const declared = new Set(abi.filter((i) => i.type === "event").map((i) => selector(i.name as string)));
    const matched = emitted.filter((e) => declared.has(e.keys[0]!));
    if (matched.length === 0) continue;
    save(`cairo0-${found}`, abi, matched.slice(0, 200));
    if (++found === 2) break;
  }
  if (found === 0) console.log("no cairo 0 contract with declared events found in range");
}
