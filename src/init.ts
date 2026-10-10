import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import pg from "pg";
import type { Abi, AbiMember } from "./abi/abi.ts";
import { abiEvents } from "./abi/events.ts";
import { classHistory } from "./abi/history.ts";
import { RpcClient } from "./rpc/client.ts";
import { blockNumber } from "./rpc/methods.ts";
import { probe } from "./rpc/probe.ts";
import { Prompt } from "./prompt.ts";
import { canonical } from "./sources.ts";

/** What `kasbah init` asks for; every one can also be given as a flag. */
export type InitOptions = {
  dir?: string;
  rpc?: string;
  address?: string;
  /** The contract's name in the app (handlers are `<name>:<Event>`). */
  name?: string;
  /** Events to index, comma-separated. Default: all of them. */
  events?: string;
  start?: string;
  database?: string;
  /** Store each event's block timestamp (`include: { block: true }`). */
  timestamps?: boolean;
  /** Take the defaults for anything not given, ask nothing. */
  yes?: boolean;
  /** The kasbah dependency, as package.json writes it. */
  kasbah?: string;
};

export type Project = {
  dir: string;
  rpc: string;
  database: string;
  name: string;
  address: string;
  abi: Abi;
  startBlock: number;
  events: string[];
  timestamps: boolean;
  kasbah: string;
};

const SMALL = new Set(["u8", "u16", "u32", "usize", "i8", "i16", "i32"].map((t) => `core::integer::${t}`));
const BIG = new Set(["core::felt252", "felt", ...["u64", "u128", "u256", "u512", "i64", "i128"].map((t) => `core::integer::${t}`)]);
const HEX = new Set([
  "core::starknet::contract_address::ContractAddress", "core::starknet::class_hash::ClassHash", "core::starknet::storage_access::StorageAddress",
  "core::starknet::eth_address::EthAddress", "core::bytes_31::bytes31",
]);
/** Columns every event table has: an argument with one of these names gets a `_` suffix. */
const FIXED = new Set(["id", "block", "timestamp", "transaction"]);

const snake = (s: string) => s.replace(/\./g, "_").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const camel = (s: string) => snake(s).replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** The column for an argument: plain values get their type, anything else (structs, enums, arrays) jsonb. */
function columnOf(m: AbiMember): { column: string; json: boolean } {
  if (SMALL.has(m.type)) return { column: "integer().notNull()", json: false };
  if (BIG.has(m.type)) return { column: "bignum().notNull()", json: false };
  if (HEX.has(m.type)) return { column: "hex().notNull()", json: false };
  if (m.type === "core::bool") return { column: "boolean().notNull()", json: false };
  if (m.type === "core::byte_array::ByteArray") return { column: "text().notNull()", json: false };
  return { column: "jsonb()", json: true };
}

/** The files of a new project, by path. */
export function generate(p: Project): Record<string, string> {
  const defs = abiEvents(p.abi).filter((e) => p.events.includes(e.name));
  const pgImports = new Set(["integer", "pgTable", "text"]);
  const kasbahImports = new Set<string>();
  let anyJson = false;
  const tables: string[] = [];
  const handlers: string[] = [];
  for (const e of defs) {
    const v = camel(e.name);
    const columns = [`  id: text().primaryKey(),`, `  block: integer().notNull(),`];
    if (p.timestamps) columns.push(`  timestamp: integer().notNull(),`);
    columns.push(`  transaction: text().notNull(),`);
    const values = ["id: `${event.transaction.hash}:${event.index}`", "block: event.block.number"];
    if (p.timestamps) values.push("timestamp: event.block.timestamp");
    values.push("transaction: event.transaction.hash");
    for (const m of [...e.keyMembers, ...e.dataMembers]) {
      const { column, json } = columnOf(m);
      const key = FIXED.has(m.name) ? `${m.name}_` : m.name;
      for (const t of ["integer", "boolean", "jsonb", "text"]) if (column.startsWith(`${t}(`)) pgImports.add(t);
      for (const t of ["bignum", "hex"]) if (column.startsWith(`${t}(`)) kasbahImports.add(t);
      columns.push(`  ${key}: ${column},`);
      values.push(`${key}: ${json ? `plain(event.args.${m.name})` : `event.args.${m.name}`}`);
      anyJson ||= json;
    }
    tables.push(`export const ${v} = pgTable("${snake(e.name)}", {\n${columns.join("\n")}\n});`);
    handlers.push(`app.on("${p.name}:${e.name}", async ({ event, context }) => {\n  await context.db.insert(schema.${v}).values({\n    ${values.join(",\n    ")},\n  });\n});`);
  }
  const abiFile = `${snake(p.name)}.ts`;
  const schemaName = snake(basename(p.dir)).replace(/[^a-z0-9_]/g, "_");
  const schemaTs = [
    `import { ${[...pgImports].sort().join(", ")} } from "drizzle-orm/pg-core";`,
    ...(kasbahImports.size > 0 ? [`import { ${[...kasbahImports].sort().join(", ")} } from "kasbah";`] : []),
    "",
    "/** One row per event: its transaction and position, its block, and its arguments. */",
    tables.join("\n\n"),
    "",
  ].join("\n");
  const appTs = [
    `import { desc } from "drizzle-orm";`,
    `import { kasbah } from "kasbah";`,
    `import ${camel(p.name)}Abi from "./abis/${abiFile}";`,
    `import * as schema from "./schema.ts";`,
    "",
    "const app = kasbah({",
    "  rpc: process.env.KASBAH_RPC_URL!,",
    "  database: process.env.DATABASE_URL!,",
    `  schema: "${schemaName}",`,
    "  contracts: {",
    `    ${p.name}: { abi: ${camel(p.name)}Abi, address: "${p.address}", startBlock: ${p.startBlock}${p.timestamps ? ", include: { block: true }" : ""} },`,
    "  },",
    "  tables: schema,",
    "  // GraphiQL at http://localhost:42069/graphql, SQL at POST /sql; API_HOST=0.0.0.0 in a container.",
    "  api: { port: 42069, host: process.env.API_HOST },",
    "  // Raw events and contract reads kept in Postgres: a re-index after a handler change fetches nothing again.",
    "  cache: true,",
    "});",
    "",
    ...(anyJson ? ["// jsonb can't hold bigints: they're stored as decimal strings.", "const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === \"bigint\" ? x.toString() : x)));", ""] : []),
    handlers.join("\n\n"),
    "",
    `// Your own endpoints, read-only on the tables: http://localhost:42069/${snake(defs[0]!.name)}/latest`,
    `app.get("/${snake(defs[0]!.name)}/latest", async ({ db }) => db.select().from(schema.${camel(defs[0]!.name)}).orderBy(desc(schema.${camel(defs[0]!.name)}.block)).limit(10));`,
    "",
    "export default app;",
    "",
  ].join("\n");
  const pkg = {
    name: basename(p.dir),
    private: true,
    type: "module",
    packageManager: "pnpm@10.12.1",
    scripts: { dev: "kasbah dev app.ts", start: "kasbah start app.ts", typecheck: "tsc" },
    dependencies: { "drizzle-orm": "^0.45.4", kasbah: p.kasbah },
    devDependencies: { "@types/node": "^24.0.0", typescript: "^5.9.0" },
  };
  const tsconfig = {
    compilerOptions: { target: "es2023", module: "nodenext", strict: true, noEmit: true, allowImportingTsExtensions: true, skipLibCheck: true, types: ["node"] },
    include: ["*.ts", "abis"],
  };
  return {
    "package.json": `${JSON.stringify(pkg, null, 2)}\n`,
    "tsconfig.json": `${JSON.stringify(tsconfig, null, 2)}\n`,
    ".gitignore": "node_modules\n.env\n",
    ".dockerignore": "node_modules\n.env\n.git\n",
    Dockerfile: DOCKERFILE,
    "docker-compose.yml": COMPOSE,
    ".env": `KASBAH_RPC_URL=${p.rpc}\nDATABASE_URL=${p.database}\n`,
    [`abis/${abiFile}`]: `export default ${JSON.stringify(p.abi, null, 2)} as const;\n`,
    "schema.ts": schemaTs,
    "app.ts": appTs,
    "README.md": [
      `# ${basename(p.dir)}`,
      "",
      `A kasbah indexer of ${p.name} (${p.address}) from block ${p.startBlock}: ${defs.map((e) => e.name).join(", ")}.`,
      "",
      "```",
      "pnpm dev               # index, follow the head, restart on every change; GraphiQL at http://localhost:42069/graphql",
      "pnpm start             # the same, without watching",
      "pnpm typecheck",
      "docker compose up -d   # Postgres and the indexer, API on 127.0.0.1:42069 (reads KASBAH_RPC_URL from .env)",
      "```",
      "",
      "`.env` holds the RPC URL and the database: keep it out of git (and out of the image: `.dockerignore`).",
      "`GET /health` answers while the indexer and its database are up, `GET /ready` once it follows the head.",
      "",
    ].join("\n"),
  };
}

const DOCKERFILE = `FROM node:24-slim
RUN npm install -g pnpm@10.12.1
WORKDIR /app
COPY . .
RUN pnpm install
ENV API_HOST=0.0.0.0
EXPOSE 42069
# kasbah itself, not through pnpm: it gets the SIGTERM of a stop and finishes the block it's on.
CMD ["node", "node_modules/kasbah/dist/cli.js", "start", "app.ts"]
`;

const COMPOSE = `services:
  postgres:
    image: postgres:17
    environment:
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:-kasbah}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "postgres"]
      interval: 5s
    restart: unless-stopped

  indexer:
    build: .
    env_file: .env
    environment:
      DATABASE_URL: postgres://postgres:\${POSTGRES_PASSWORD:-kasbah}@postgres:5432/postgres
    # Localhost only: put a proxy (Caddy, nginx) in front for the outside, with TLS and rate limits.
    ports:
      - "127.0.0.1:42069:42069"
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:42069/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
      interval: 30s
      start_period: 30s
    stop_grace_period: 30s
    restart: unless-stopped

volumes:
  pgdata:
`;

/**
 * The dependency on this kasbah: from a checkout its packed tarball, copied into the project so a Docker build sees
 * it (a link would bring the checkout's own drizzle-orm); else its version.
 */
function kasbahSpec(): { spec: string; tarball?: string } {
  const root = resolve(import.meta.dirname, "..");
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  if (!existsSync(join(root, ".git"))) return { spec: `^${version}` };
  const tarball = join(root, `kasbah-${version}.tgz`);
  if (!existsSync(tarball)) throw new Error(`no ${tarball}: run pnpm pack in ${root} first`);
  return { spec: `file:./vendor/${basename(tarball)}`, tarball };
}

/** A name for the contract from its largest interface (`ekubo::interfaces::core::ICore` → `Core`). */
function nameOf(abi: Abi): string {
  const interfaces = abi.filter((x) => x.type === "interface") as { name?: string; items?: readonly unknown[] }[];
  const i = interfaces.sort((a, b) => (b.items?.length ?? 0) - (a.items?.length ?? 0))[0];
  const last = i?.name?.split("::").at(-1)?.replace(/^I(?=[A-Z])/, "");
  return last !== undefined && /^[A-Za-z]\w*$/.test(last) ? last : "Contract";
}

export async function init(o: InitOptions): Promise<void> {
  const ui = new Prompt();
  const ask = process.stdin.isTTY === true && o.yes !== true;
  const need = (flag: string) => {
    throw new Error(`--${flag} is required without a terminal (or with --yes)`);
  };
  ui.line(`${ui.bold("kasbah init")}  ${ui.dim("a new indexer for one Starknet contract")}`);
  ui.line();

  const dir = o.dir ?? (ask ? await ui.text("Directory", { initial: "my-indexer" }) : "my-indexer");
  const target = resolve(dir);
  if (existsSync(target) && readdirSync(target).length > 0) throw new Error(`${target} is not empty`);

  let rpc = o.rpc ?? (ask ? undefined : process.env.KASBAH_RPC_URL ?? need("rpc"));
  let client: RpcClient;
  for (;;) {
    rpc ??= await ui.text("Starknet RPC URL", { initial: process.env.KASBAH_RPC_URL, hint: "spec 0.10 (pathfinder or juno), e.g. https://starknet-mainnet.g.alchemy.com/starknet/version/rpc/v0_10/<key>", check: (v) => (/^https?:\/\//.test(v) ? undefined : "an http(s) URL") });
    client = new RpcClient(rpc, { maxAttempts: 2 });
    try {
      const c = client;
      await ui.step("Connecting", async () => ({ e: await probe(c), tip: await blockNumber(c) }), ({ e, tip }) => `${e.node}${e.nodeVersion === undefined ? "" : ` ${e.nodeVersion}`}, spec ${e.spec}, tip ${tip.toLocaleString("en")}`);
      break;
    } catch (e) {
      if (!ask) throw e;
      rpc = undefined;
    }
  }

  let address = o.address ?? (ask ? undefined : need("address"));
  let abi: Abi;
  for (;;) {
    address ??= await ui.text("Contract address", { check: (v) => (/^0x[0-9a-fA-F]{1,64}$/.test(v) ? undefined : "a 0x… felt") });
    try {
      const a = canonical(address);
      abi = await ui.step("Reading its class", async () => {
        const hash = await client.request<string>("starknet_getClassHashAt", { block_id: "latest", contract_address: a });
        const cls = await client.request<{ abi: string | Abi }>("starknet_getClass", { block_id: "latest", class_hash: hash });
        return (typeof cls.abi === "string" ? JSON.parse(cls.abi) : cls.abi) as Abi;
      }, (x) => `${abiEvents(x).length} events in its ABI`);
      if (abiEvents(abi).length === 0) throw new Error("its class declares no events (a Cairo 0 proxy? give the implementation's address)");
      break;
    } catch (e) {
      if (!ask) throw e;
      address = undefined;
    }
  }

  const name = o.name ?? (ask ? await ui.text("Name in the app", { initial: nameOf(abi), hint: "handlers are <name>:<Event>", check: (v) => (/^[A-Za-z]\w*$/.test(v) ? undefined : "letters, digits and _") }) : nameOf(abi));
  const all = abiEvents(abi).map((e) => e.name);
  let events: string[];
  if (o.events !== undefined) {
    events = o.events.split(",").map((e) => e.trim());
    for (const e of events) if (!all.includes(e)) throw new Error(`the ABI has no event ${e} (it has ${all.join(", ")})`);
  } else events = ask ? await ui.multi("Events to index", all.map((e) => ({ label: e, value: e }))) : all;

  const tip = await blockNumber(client);
  let deployed = 0;
  if (o.start === undefined) {
    const a = canonical(address);
    deployed = await ui.step("Finding its deployment block", async () => (await classHistory(client, a, 0, tip))[0]?.from ?? 0, (b) => `block ${b.toLocaleString("en")}`);
  }
  const startBlock = Number(o.start ?? (ask ? await ui.text("Start block", { initial: String(deployed), hint: "its deployment block indexes everything; a later one only what comes after", check: (v) => (/^\d+$/.test(v) && Number(v) <= tip ? undefined : `a block number up to ${tip}`) }) : deployed));
  const timestamps = o.timestamps ?? (ask ? await ui.confirm("Store block timestamps? (one extra call per block with events)", false) : false);

  let database = o.database ?? (ask ? undefined : process.env.DATABASE_URL ?? need("database"));
  for (;;) {
    database ??= await ui.text("Postgres URL", { initial: process.env.DATABASE_URL ?? "postgres://postgres@localhost:5432/postgres", check: (v) => (/^postgres(ql)?:\/\//.test(v) ? undefined : "a postgres:// URL") });
    const pool = new pg.Pool({ connectionString: database, max: 1, connectionTimeoutMillis: 5_000 });
    try {
      await ui.step("Connecting to Postgres", async () => (await pool.query<{ v: string }>("SELECT current_setting('server_version') AS v")).rows[0]!.v, (v) => `Postgres ${v}`);
      break;
    } catch {
      // Not up yet is fine (docker compose brings its own): only `kasbah dev` needs it.
      if (!ask || (await ui.confirm("Keep this URL anyway?", false))) break;
      database = undefined;
    } finally {
      await pool.end();
    }
  }

  const dependency = o.kasbah === undefined ? kasbahSpec() : { spec: o.kasbah };
  const files = generate({ dir: target, rpc, database, name, address: canonical(address), abi, startBlock, events, timestamps, kasbah: dependency.spec });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(target, path)), { recursive: true });
    writeFileSync(join(target, path), content);
  }
  if (dependency.tarball !== undefined) {
    mkdirSync(join(target, "vendor"), { recursive: true });
    copyFileSync(dependency.tarball, join(target, "vendor", basename(dependency.tarball)));
  }
  ui.line();
  ui.line(`${ui.green("✓")} ${ui.bold(target)}`);
  for (const path of Object.keys(files).sort()) ui.line(`  ${path}${path === ".env" ? ui.dim("  (the RPC URL and database: kept out of git)") : ""}`);
  ui.line();

  const pm = process.env.npm_config_user_agent?.startsWith("npm") ? "npm" : "pnpm";
  if (ask && (await ui.confirm(`Install the dependencies now (${pm} install)?`))) {
    const r = spawnSync(pm, ["install"], { cwd: target, stdio: "inherit" });
    if (r.status !== 0) ui.line(ui.yellow(`${pm} install failed: run it in ${dir}`));
  } else ui.line(`  cd ${dir} && ${pm} install`);
  ui.line();
  ui.line(`Then ${ui.cyan(`${pm} dev`)} in ${dir}: it indexes from block ${startBlock.toLocaleString("en")}, follows the head and restarts on every change.`);
  ui.line(`GraphiQL at ${ui.cyan("http://localhost:42069/graphql")} once it runs.`);
}
