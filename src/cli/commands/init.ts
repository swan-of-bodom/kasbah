import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import pg from "pg";
import type { Abi, AbiMember } from "../../abi/abi.ts";
import { abiEvents } from "../../abi/events.ts";
import { deployedAt } from "../../abi/history.ts";
import { ConfigError } from "../../config/errors.ts";
import { NETWORKS, type Network, networkName } from "../../config/network.ts";
import { schemaName } from "../../config/resolve.ts";
import { RpcClient } from "../../rpc/client.ts";
import { blockNumber } from "../../rpc/methods.ts";
import { probe } from "../../rpc/probe.ts";
import { canonical } from "../../types/felt.ts";
import { Prompt } from "../ui/prompt.ts";

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
  /** New blocks over a WebSocket (`ws: true`) instead of polling. Default: yes. */
  ws?: boolean;
  /** Take the defaults for anything not given, ask nothing. */
  yes?: boolean;
  /** The kasbah dependency, as package.json writes it. */
  dependency?: string;
  /** Start from one of `TEMPLATES` instead of a contract address. */
  template?: string;
};

/** What every new project has, from a contract or a template. */
type Common = {
  dir: string;
  rpc: string;
  /** `undefined`: none in `.env`, so `dev` starts a container. */
  database: string | undefined;
  dependency: string;
};

export type Project = Common & {
  /** The RPC's network, written into the config so another network's RPC is refused; none for other chains. */
  network: Network | undefined;
  name: string;
  address: string;
  abi: Abi;
  startBlock: number;
  events: string[];
  timestamps: boolean;
  ws: boolean;
};

/** Projects to start from, in `templates/`: each holds the app's own files, and `init` adds the rest. */
export const TEMPLATES = {
  erc20: "LORDS: balances, transfers and allowances, with GraphQL relations between them",
  ekubo: "Ekubo's Core: every pool, with its swaps",
  jediswap:
    "JediSwap v1: the pairs its factory creates, found as it runs, with their swaps and reserves",
} as const;

export type Template = keyof typeof TEMPLATES;

const TEMPLATES_DIR = resolve(import.meta.dirname, "../../../templates");

const SMALL = new Set(
  ["u8", "u16", "u32", "usize", "i8", "i16", "i32"].map((t) => `core::integer::${t}`),
);
const BIG = new Set([
  "core::felt252",
  "felt",
  ...["u64", "u128", "u256", "u512", "i64", "i128"].map((t) => `core::integer::${t}`),
]);
const HEX = new Set([
  "core::starknet::contract_address::ContractAddress",
  "core::starknet::class_hash::ClassHash",
  "core::starknet::storage_access::StorageAddress",
  "core::starknet::eth_address::EthAddress",
  "core::bytes_31::bytes31",
]);
/** The Hono a new project's API is written against (kasbah needs 4.5 or later). */
const HONO = "^4.13.0";

/** Columns every event table has: an argument with one of these names gets a `_` suffix. */
const FIXED = new Set(["id", "block", "timestamp", "transaction"]);

const snake = (s: string) =>
  s
    .replace(/\./g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
const camel = (s: string) => snake(s).replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

const isNetwork = (name: string): name is Network => name in NETWORKS;

function columnOf(m: AbiMember): string {
  if (SMALL.has(m.type)) return "integer().notNull()";
  if (BIG.has(m.type)) return "bignum().notNull()";
  if (HEX.has(m.type)) return "hex().notNull()";
  if (m.type === "core::bool") return "boolean().notNull()";
  if (m.type === "core::byte_array::ByteArray") return "text().notNull()";
  return "jsonb()";
}

/** The files of a new project, by path. */
export function generate(p: Project): Record<string, string> {
  const defs = abiEvents(p.abi).filter((e) => p.events.includes(e.name));
  const imports = new Set(["integer", "pgTable", "text"]);
  const tables: string[] = [];
  const handlers: string[] = [];
  for (const e of defs) {
    const v = camel(e.name);
    const columns = [`  id: text().primaryKey(),`, `  block: integer().notNull(),`];
    if (p.timestamps) columns.push(`  timestamp: integer().notNull(),`);
    columns.push(`  transaction: text().notNull(),`);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the generated handler's template literal
    const values = ["id: `${event.transaction.hash}:${event.index}`", "block: event.block.number"];
    if (p.timestamps) values.push("timestamp: event.block.timestamp");
    values.push("transaction: event.transaction.hash");
    for (const m of [...e.keyMembers, ...e.dataMembers]) {
      const column = columnOf(m);
      const key = FIXED.has(m.name) ? `${m.name}_` : m.name;
      for (const t of ["integer", "boolean", "jsonb", "text"])
        if (column.startsWith(`${t}(`)) imports.add(t);
      for (const t of ["bignum", "hex"]) if (column.startsWith(`${t}(`)) imports.add(t);
      columns.push(`  ${key}: ${column},`);
      values.push(`${key}: event.args.${m.name}`);
    }
    tables.push(`export const ${v} = pgTable("${snake(e.name)}", {\n${columns.join("\n")}\n});`);
    handlers.push(
      `app.on("${p.name}:${e.name}", async ({ event, context }) => {\n  await context.db.insert(schema.${v}).values({\n    ${values.join(",\n    ")},\n  });\n});`,
    );
  }
  const abiName = `${camel(p.name)}Abi`;
  const first = camel(defs[0]!.name);
  const lines = (...l: string[]) => `${l.join("\n")}\n`;
  const config = lines(
    `import { kasbah } from "kasbah";`,
    `import ${abiName} from "./abis/${p.name}.ts";`,
    "",
    "export default kasbah({",
    ...(p.network === undefined ? [] : [`  network: "${p.network}",`]),
    "  rpc: process.env.KASBAH_RPC_URL!,",
    ...(p.ws ? ["  ws: true,"] : []),
    "  contracts: {",
    `    ${p.name}: { abi: ${abiName}, address: "${p.address}", startBlock: ${p.startBlock}${p.timestamps ? ", include: { block: true }" : ""} },`,
    "  },",
    "  cache: true,",
    "});",
  );
  const schemaTs = lines(
    `import { ${[...imports].sort().join(", ")} } from "kasbah";`,
    "",
    tables.join("\n\n"),
  );
  const index = lines(
    `import app from "../kasbah.config.ts";`,
    `import * as schema from "../kasbah.schema.ts";`,
    "",
    handlers.join("\n\n"),
  );
  const api = lines(
    `import { Hono } from "hono";`,
    `import { desc, replaceBigInts } from "kasbah";`,
    `import { db, graphql } from "kasbah/api";`,
    `import * as schema from "../../kasbah.schema.ts";`,
    "",
    "const app = new Hono();",
    "",
    `app.use("/graphql", graphql({ db, schema }));`,
    "",
    `app.get("/${snake(defs[0]!.name)}/latest", async (c) => {`,
    `  const rows = await db.select().from(schema.${first}).orderBy(desc(schema.${first}.block)).limit(10);`,
    "  return c.json(replaceBigInts(rows, String));",
    "});",
    "",
    "export default app;",
  );
  return {
    "kasbah.config.ts": config,
    "kasbah.schema.ts": schemaTs,
    [`abis/${p.name}.ts`]: `export default ${JSON.stringify(p.abi, null, 2)} as const;\n`,
    "src/index.ts": index,
    "src/api/index.ts": api,
    ...commonFiles(
      p,
      `Indexes ${p.name} (${p.address}) from block ${p.startBlock}: ${defs.map((e) => e.name).join(", ")}.`,
    ),
  };
}

/** A template's files, and the project's around them. */
export function templateFiles(template: Template, p: Common): Record<string, string> {
  const root = join(TEMPLATES_DIR, template);
  const files: Record<string, string> = {};
  for (const path of (readdirSync(root, { recursive: true }) as string[]).sort())
    if (statSync(join(root, path)).isFile())
      files[path.split("\\").join("/")] = readFileSync(join(root, path), "utf8");
  return {
    ...files,
    ...commonFiles(p, `${TEMPLATES[template]}. From kasbah's \`${template}\` template.`),
  };
}

/** The files around the app's own: package, TypeScript, environment, Docker and README, which starts with `about`. */
function commonFiles(p: Common, about: string): Record<string, string> {
  const lines = (...l: string[]) => `${l.join("\n")}\n`;
  const pkg = {
    name: basename(p.dir),
    private: true,
    type: "module",
    packageManager: "pnpm@10.12.1",
    scripts: {
      dev: "kasbah dev",
      fresh: "kasbah dev --reset",
      clean: "kasbah clean",
      start: "kasbah start",
      serve: "kasbah serve",
      typecheck: "tsc",
    },
    dependencies: { kasbah: p.dependency, hono: HONO },
    devDependencies: { "@types/node": "^24.0.0", typescript: "^5.9.0" },
  };
  const tsconfig = {
    compilerOptions: {
      target: "es2023",
      module: "nodenext",
      strict: true,
      noEmit: true,
      allowImportingTsExtensions: true,
      skipLibCheck: true,
      types: ["node"],
    },
    include: ["*.ts", "abis", "src"],
  };
  const env = (rpc: string, database: string | undefined) =>
    lines(
      `KASBAH_RPC_URL=${rpc}`,
      database === undefined
        ? "# DATABASE_URL=postgresql://…  (unset: `pnpm dev` runs Postgres in a Docker or Podman container)"
        : `DATABASE_URL=${database}`,
    );
  return {
    "package.json": `${JSON.stringify(pkg, null, 2)}\n`,
    "tsconfig.json": `${JSON.stringify(tsconfig, null, 2)}\n`,
    ".env": env(p.rpc, p.database),
    ".env.example": env(
      "https://starknet-mainnet.g.alchemy.com/starknet/version/rpc/v0_10/<key>",
      undefined,
    ),
    ".gitignore": "node_modules\n.env\n",
    ".dockerignore": "node_modules\n.env\n.git\n",
    Dockerfile: DOCKERFILE,
    "docker-compose.yml": compose(schemaName(basename(p.dir))),
    "README.md": lines(
      `# ${basename(p.dir)}`,
      "",
      about,
      "",
      "- `kasbah.config.ts`: RPC, database, contracts, API",
      "- `kasbah.schema.ts`: the tables",
      "- `src/index.ts`: what each event writes",
      "- `src/api/index.ts`: the HTTP API, a Hono app: GraphQL at `/graphql`, and your own endpoints",
      "",
      "```",
      "pnpm dev               # index and follow the head, restarted on every change; GraphiQL at http://localhost:42069/graphql",
      `pnpm start --schema ${schemaName(basename(p.dir))}   # the same for production, without watching (a new schema per deploy)`,
      `pnpm serve --schema ${schemaName(basename(p.dir))}   # the API alone, over what start indexed`,
      "docker compose up -d   # Postgres and the indexer, the API on 127.0.0.1:42069",
      "```",
      "",
      "`.env` holds the RPC URL (and the database, if not the dev container): it stays out of git and the image.",
      ...(p.dependency.startsWith("file:")
        ? [
            "",
            "kasbah comes from a local tarball (a checkout's): `docker compose` builds once it's `pnpm add kasbah` from npm.",
          ]
        : []),
    ),
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
CMD ["node", "node_modules/kasbah/dist/cli/main.js", "start"]
`;

const compose = (schema: string) => `services:
  postgres:
    image: docker.io/library/postgres:17
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
      # start needs one: a new one when the build changes (config, tables or handlers).
      DATABASE_SCHEMA: \${DATABASE_SCHEMA:-${schema}}
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

/** The dependency on kasbah: from a checkout its packed tarball (a link would bring the checkout's own node_modules), else its version. */
function indexerSpec(): string {
  const root = resolve(import.meta.dirname, "../../..");
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version: string;
  };
  if (!existsSync(join(root, ".git"))) return `^${version}`;
  const tarball = join(root, `kasbah-${version}.tgz`);
  if (!existsSync(tarball)) throw new Error(`no ${tarball}: run pnpm pack in ${root} first`);
  return `file:${tarball}`;
}

function nameOf(abi: Abi): string {
  const interfaces = abi.filter((x) => x.type === "interface") as {
    name?: string;
    items?: readonly unknown[];
  }[];
  const i = interfaces.sort((a, b) => (b.items?.length ?? 0) - (a.items?.length ?? 0))[0];
  const last = i?.name
    ?.split("::")
    .at(-1)
    ?.replace(/^I(?=[A-Z])/, "");
  return last !== undefined && /^[A-Za-z]\w*$/.test(last) ? last : "Contract";
}

type Asking = { ui: Prompt; ask: boolean; need: (flag: string) => never };

export async function init(o: InitOptions): Promise<void> {
  const ui = new Prompt();
  const a: Asking = {
    ui,
    ask: process.stdin.isTTY === true && o.yes !== true,
    need: (flag) => {
      throw new ConfigError(`--${flag} is required without a terminal (or with --yes)`);
    },
  };
  ui.line(`${ui.bold("kasbah init")}  ${ui.dim("a new Starknet indexer")}`);
  ui.line();

  const template = await askTemplate(a, o);
  const dir =
    o.dir ??
    (a.ask ? await ui.text("Directory", { initial: template ?? "my-indexer" }) : "my-indexer");
  const target = resolve(dir);
  if (existsSync(target) && readdirSync(target).length > 0)
    throw new ConfigError(`${target} is not empty`);
  const { rpc, client, network } = await askRpc(a, o);
  if (template !== undefined) {
    if (network !== "mainnet")
      throw new ConfigError(
        `the ${template} template indexes mainnet contracts: give a mainnet RPC (this one is ${network ?? "another chain"})`,
      );
    const database = await askDatabase(a, o);
    const dependency = o.dependency ?? indexerSpec();
    write(ui, target, templateFiles(template, { dir: target, rpc, database, dependency }));
    await nextSteps(a, dir, target);
    return;
  }
  const { address, abi } = await askContract(a, o, client);
  const name =
    o.name ??
    (a.ask
      ? await ui.text("Name in the app", {
          initial: nameOf(abi),
          hint: "handlers are <name>:<Event>",
          check: (v) => (/^[A-Za-z]\w*$/.test(v) ? undefined : "letters, digits and _"),
        })
      : nameOf(abi));
  const events = await askEvents(a, o, abi);
  const startBlock = await askStart(a, o, client, address);
  const timestamps =
    o.timestamps ??
    (a.ask
      ? await ui.confirm("Store block timestamps? (one extra call per block with events)", false)
      : false);
  const ws =
    o.ws ??
    (a.ask
      ? await ui.confirm("New blocks over a WebSocket? (about a second fresher than polling)", true)
      : true);
  const database = await askDatabase(a, o);

  const files = generate({
    dir: target,
    rpc,
    network,
    database,
    name,
    address,
    abi,
    startBlock,
    events,
    timestamps,
    ws,
    dependency: o.dependency ?? indexerSpec(),
  });
  write(ui, target, files);
  await nextSteps(a, dir, target, startBlock);
}

function write(ui: Prompt, target: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(target, path)), { recursive: true });
    writeFileSync(join(target, path), content);
  }
  ui.line();
  ui.line(`${ui.green("✓")} ${ui.bold(target)}`);
  for (const path of Object.keys(files))
    ui.line(
      `  ${path}${path === ".env" ? ui.dim("  (the RPC URL and database: kept out of git)") : ""}`,
    );
  ui.line();
}

async function askTemplate({ ui, ask }: Asking, o: InitOptions): Promise<Template | undefined> {
  if (o.template !== undefined) {
    if (!Object.hasOwn(TEMPLATES, o.template))
      throw new ConfigError(
        `no template ${o.template} (there are ${Object.keys(TEMPLATES).join(", ")})`,
      );
    if (o.address !== undefined)
      throw new ConfigError("--template and --address don't go together: pick one to start from");
    return o.template as Template;
  }
  if (!ask || o.address !== undefined) return undefined;
  return ui.select<Template | undefined>("Start from", [
    { label: "A contract address", value: undefined, hint: "a table per event, from its ABI" },
    ...Object.entries(TEMPLATES).map(([name, about]) => ({
      label: `The ${name} template`,
      value: name as Template,
      hint: about,
    })),
  ]);
}

async function askRpc({ ui, ask, need }: Asking, o: InitOptions) {
  let rpc = o.rpc ?? (ask ? undefined : (process.env.KASBAH_RPC_URL ?? need("rpc")));
  for (;;) {
    rpc ??= await ui.text("Starknet RPC URL", {
      initial: process.env.KASBAH_RPC_URL,
      hint: "spec 0.10 (pathfinder or juno), e.g. https://starknet-mainnet.g.alchemy.com/starknet/version/rpc/v0_10/<key>",
      check: (v) => (/^https?:\/\//.test(v) ? undefined : "an http(s) URL"),
    });
    const client = new RpcClient(rpc, { maxAttempts: 2 });
    try {
      const connected = await ui.step(
        "Connecting",
        async () => ({
          e: await probe(client),
          tip: await blockNumber(client),
          chain: networkName(await client.request<string>("starknet_chainId", [])),
        }),
        ({ e, tip, chain }) =>
          `${chain}, ${e.node}${e.nodeVersion === undefined ? "" : ` ${e.nodeVersion}`}, spec ${e.spec}, tip ${tip.toLocaleString("en")}`,
      );
      return { rpc, client, network: isNetwork(connected.chain) ? connected.chain : undefined };
    } catch (e) {
      if (!ask) throw e;
      rpc = undefined;
    }
  }
}

async function askContract({ ui, ask, need }: Asking, o: InitOptions, client: RpcClient) {
  let address = o.address ?? (ask ? undefined : need("address"));
  for (;;) {
    address ??= await ui.text("Contract address", {
      check: (v) => (/^0x[0-9a-fA-F]{1,64}$/.test(v) ? undefined : "a 0x… felt"),
    });
    try {
      const a = canonical(address);
      const abi = await ui.step(
        "Reading its class",
        async () => {
          const hash = await client.request<string>("starknet_getClassHashAt", {
            block_id: "latest",
            contract_address: a,
          });
          const cls = await client.request<{ abi: string | Abi }>("starknet_getClass", {
            block_id: "latest",
            class_hash: hash,
          });
          return (typeof cls.abi === "string" ? JSON.parse(cls.abi) : cls.abi) as Abi;
        },
        (x) => `${abiEvents(x).length} events in its ABI`,
      );
      if (abiEvents(abi).length === 0)
        throw new ConfigError(
          "its class declares no events (a Cairo 0 proxy? give the implementation's address)",
        );
      return { address: a, abi };
    } catch (e) {
      if (!ask) throw e;
      address = undefined;
    }
  }
}

async function askEvents({ ui, ask }: Asking, o: InitOptions, abi: Abi): Promise<string[]> {
  const all = abiEvents(abi).map((e) => e.name);
  if (o.events === undefined)
    return ask
      ? await ui.multi(
          "Events to index",
          all.map((e) => ({ label: e, value: e })),
        )
      : all;
  const events = o.events.split(",").map((e) => e.trim());
  for (const e of events)
    if (!all.includes(e))
      throw new ConfigError(`the ABI has no event ${e} (it has ${all.join(", ")})`);
  return events;
}

async function askStart(
  { ui, ask }: Asking,
  o: InitOptions,
  client: RpcClient,
  address: string,
): Promise<number> {
  const tip = await blockNumber(client);
  let deployed = 0;
  if (o.start === undefined)
    deployed = await ui.step(
      "Finding its deployment block",
      async () => (await deployedAt(client, address, tip)) ?? 0,
      (b) => `block ${b.toLocaleString("en")}`,
    );
  return Number(
    o.start ??
      (ask
        ? await ui.text("Start block", {
            initial: String(deployed),
            hint: "its deployment block indexes everything; a later one only what comes after",
            check: (v) =>
              /^\d+$/.test(v) && Number(v) <= tip ? undefined : `a block number up to ${tip}`,
          })
        : deployed),
  );
}

async function askDatabase({ ui, ask }: Asking, o: InitOptions): Promise<string | undefined> {
  let database =
    o.database === "" ? undefined : (o.database ?? (ask ? undefined : process.env.DATABASE_URL));
  for (; ask || database !== undefined; ) {
    if (database === undefined) {
      const answer = await ui.text("Postgres URL", {
        initial: process.env.DATABASE_URL,
        hint: "empty: `pnpm dev` runs one in a Docker or Podman container",
        check: (v) =>
          v === "" || /^postgres(ql)?:\/\//.test(v) ? undefined : "a postgres:// URL, or empty",
      });
      if (answer === "") break;
      database = answer;
    }
    const pool = new pg.Pool({
      connectionString: database,
      max: 1,
      connectionTimeoutMillis: 5_000,
    });
    try {
      await ui.step(
        "Connecting to Postgres",
        async () =>
          (await pool.query<{ v: string }>("SELECT current_setting('server_version') AS v"))
            .rows[0]!.v,
        (v) => `Postgres ${v}`,
      );
      break;
    } catch {
      if (!ask || (await ui.confirm("Keep this URL anyway?", false))) break;
      database = undefined;
    } finally {
      await pool.end();
    }
  }
  return database;
}

async function nextSteps({ ui, ask }: Asking, dir: string, target: string, startBlock?: number) {
  const pm = process.env.npm_config_user_agent?.startsWith("npm") ? "npm" : "pnpm";
  if (ask && (await ui.confirm(`Install the dependencies now (${pm} install)?`))) {
    const r = spawnSync(pm, ["install"], { cwd: target, stdio: "inherit" });
    if (r.status !== 0) ui.line(ui.yellow(`${pm} install failed: run it in ${dir}`));
  } else ui.line(`  cd ${dir} && ${pm} install`);
  ui.line();
  ui.line(
    `Then ${ui.cyan(`${pm} dev`)} in ${dir}: it indexes from ${startBlock === undefined ? "the config's start block" : `block ${startBlock.toLocaleString("en")}`}, follows the head and restarts on every change.`,
  );
  ui.line(`GraphiQL at ${ui.cyan("http://localhost:42069/graphql")} once it runs.`);
}
