import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
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
  /** Installs with it, and writes the project for it. Default: the one running `create`, else pnpm. */
  packageManager?: PackageManager;
  skipInstall?: boolean;
  /** Without it, the project is a git repository with one commit (unless it's inside one already). */
  skipGit?: boolean;
};

export type PackageManager = "pnpm" | "npm" | "yarn";

/** What every new project has, from a contract or a template. */
type Common = {
  dir: string;
  rpc: string;
  /** `undefined`: none in `.env`, so `dev` starts a container. */
  database: string | undefined;
  dependency: string;
  /** Default: pnpm. */
  packageManager?: PackageManager;
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

/**
 * A file every new project gets, from `templates/_project`, its `{{name}}` placeholders filled from `values`. The
 * ignore files are stored without their dot: npm leaves a `.gitignore` out of a package.
 */
function projectFile(name: string, values: Record<string, string> = {}): string {
  const text = readFileSync(join(TEMPLATES_DIR, "_project", name), "utf8");
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key]!);
}

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

/** Lines as a file's text, ending in a newline. */
const lines = (...l: string[]) => `${l.join("\n")}\n`;

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
      imports.add(column.slice(0, column.indexOf("(")));
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
  const pm = p.packageManager ?? "pnpm";
  const run = (script: string, args = "") => runCommand(pm, script, args);
  const pkg = {
    name: basename(p.dir),
    private: true,
    type: "module",
    ...(pm === "pnpm" ? { packageManager: PNPM } : {}),
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
  const env = (rpc: string, database: string | undefined) =>
    lines(
      ...(rpc === PUBLIC_RPC ? [`# ${PUBLIC_RPC_NOTE}`] : []),
      `KASBAH_RPC_URL=${rpc}`,
      database === undefined
        ? "# DATABASE_URL=postgresql://…  (unset: `pnpm dev` runs Postgres in a Docker or Podman container)"
        : `DATABASE_URL=${database}`,
    );
  return {
    "package.json": `${JSON.stringify(pkg, null, 2)}\n`,
    "tsconfig.json": projectFile("tsconfig.json"),
    ".env": env(p.rpc, p.database),
    ".env.example": env(
      "https://starknet-mainnet.g.alchemy.com/starknet/version/rpc/v0_10/<key>",
      undefined,
    ),
    ".gitignore": projectFile("gitignore"),
    ".dockerignore": projectFile("dockerignore"),
    Dockerfile: projectFile("Dockerfile", { install: INSTALL[pm] }),
    // Yarn 2 and later would otherwise install without node_modules, where the image runs kasbah from.
    ...(pm === "yarn" ? { ".yarnrc.yml": "nodeLinker: node-modules\n" } : {}),
    "docker-compose.yml": projectFile("docker-compose.yml", {
      schema: schemaName(basename(p.dir)),
    }),
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
      `${run("dev")}   # index and follow the head, restarted on every change; GraphiQL at http://localhost:42069/graphql`,
      `${run("start", `--schema ${schemaName(basename(p.dir))}`)}   # the same for production, without watching (a new schema per deploy)`,
      `${run("serve", `--schema ${schemaName(basename(p.dir))}`)}   # the API alone, over what start indexed`,
      "docker compose up -d   # Postgres and the indexer, the API on 127.0.0.1:42069",
      "```",
      "",
      "`.env` holds the RPC URL (and the database, if not the dev container): it stays out of git and the image.",
      ...(p.dependency.startsWith("file:")
        ? [
            "",
            `kasbah comes from a local tarball (a checkout's): \`docker compose\` builds once it's \`${pm} add kasbah\` from npm.`,
          ]
        : []),
    ),
  };
}

/**
 * The RPC `init` offers: free and public (Juno, spec 0.10, mainnet), checked 2026-11-04, about 1.2 s for a page of 1,000
 * events. Blast's and Lava's public endpoints, once the usual free ones, had closed by then.
 */
const PUBLIC_RPC = "https://starknet-rpc.publicnode.com";

/** Said where the public RPC is written: fine to try kasbah, too slow and rate-limited for a long backfill. */
const PUBLIC_RPC_NOTE =
  "A free public RPC, to try kasbah: replace it with a provider's (Alchemy, Infura, your own node) for a long backfill.";

/** The pnpm a project asks for (`packageManager`), and its image installs. */
const PNPM = "pnpm@10.12.1";

/** `script` with `args` as `pm` runs it: npm needs `run`, and `--` before arguments. */
function runCommand(pm: PackageManager, script: string, args = ""): string {
  if (pm === "npm") return `npm run ${script}${args === "" ? "" : ` -- ${args}`}`;
  return `${pm} ${script}${args === "" ? "" : ` ${args}`}`;
}

const INSTALL: Record<PackageManager, string> = {
  pnpm: `RUN npm install -g ${PNPM}\nWORKDIR /app\nCOPY . .\nRUN pnpm install`,
  npm: "WORKDIR /app\nCOPY . .\nRUN npm install",
  yarn: "RUN corepack enable\nWORKDIR /app\nCOPY . .\nRUN yarn install",
};

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

  checkTemplate(o);
  const dir =
    o.dir ?? (a.ask ? await ui.text("Project directory", { initial: "my-indexer" }) : "my-indexer");
  const target = resolve(dir);
  if (existsSync(target) && readdirSync(target).length > 0)
    throw new ConfigError(`${target} is not empty`);
  const template = await askTemplate(a, o);
  const packageManager = o.packageManager ?? fromUserAgent() ?? "pnpm";
  const { rpc, client, network } = await askRpc(a, o);
  if (template !== undefined) {
    if (network !== "mainnet")
      throw new ConfigError(
        `the ${template} template indexes mainnet contracts: give a mainnet RPC (this one is ${network ?? "another chain"})`,
      );
    const database = await askDatabase(a, o);
    const dependency = o.dependency ?? indexerSpec();
    write(
      ui,
      target,
      templateFiles(template, { dir: target, rpc, database, dependency, packageManager }),
    );
    await finish(ui, o, target, packageManager, rpc);
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
    packageManager,
  });
  write(ui, target, files);
  await finish(ui, o, target, packageManager, rpc, startBlock);
}

/** The package manager running `pnpm create` (or `npm init`, `yarn create`), from the variable it sets. */
function fromUserAgent(): PackageManager | undefined {
  const agent = process.env.npm_config_user_agent ?? "";
  for (const pm of ["pnpm", "yarn", "npm"] as const) if (agent.startsWith(pm)) return pm;
  return undefined;
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

/** A bad `--template` is refused before any question. */
function checkTemplate(o: InitOptions) {
  if (o.template === undefined) return;
  if (!Object.hasOwn(TEMPLATES, o.template))
    throw new ConfigError(
      `no template ${o.template} (there are ${Object.keys(TEMPLATES).join(", ")})`,
    );
  if (o.address !== undefined)
    throw new ConfigError("--template and --address don't go together: pick one to start from");
}

async function askTemplate({ ui, ask }: Asking, o: InitOptions): Promise<Template | undefined> {
  if (o.template !== undefined) return o.template as Template;
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

async function askRpc({ ui, ask }: Asking, o: InitOptions) {
  let rpc = o.rpc ?? (ask ? undefined : (process.env.KASBAH_RPC_URL ?? PUBLIC_RPC));
  for (;;) {
    rpc ??= await ui.text("Starknet RPC URL", {
      initial: process.env.KASBAH_RPC_URL ?? PUBLIC_RPC,
      hint: "spec 0.10 (pathfinder or juno); a free public one by default, a provider's (Alchemy: …/starknet/version/rpc/v0_10/<key>) is faster",
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

/** Installs the packages and makes a git repository, unless skipped, then says how to start. */
async function finish(
  ui: Prompt,
  o: InitOptions,
  target: string,
  pm: PackageManager,
  rpc: string,
  startBlock?: number,
) {
  const exec = promisify(execFile);
  if (!o.skipInstall)
    try {
      await ui.step(
        `Installing packages with ${pm}`,
        // pnpm skips devDependencies when NODE_ENV is production: the project's TypeScript is one.
        () =>
          exec(pm, ["install"], { cwd: target, env: { ...process.env, NODE_ENV: "development" } }),
        () => "done",
      );
    } catch (e) {
      ui.line(ui.yellow(`  ${pm} install failed: run it in the project`));
      const output = (e as { stderr?: string }).stderr?.trim();
      if (output) ui.line(ui.dim(output.split("\n").slice(-5).join("\n")));
    }
  if (!o.skipGit && !(await insideRepository(target)))
    try {
      await ui.step(
        "Making a git repository",
        async () => {
          await exec("git", ["init", "--quiet"], { cwd: target });
          await exec("git", ["add", "."], { cwd: target });
          await exec(
            "git",
            ["commit", "--quiet", "--no-verify", "-m", "Initial commit from kasbah init"],
            {
              cwd: target,
            },
          );
        },
        () => "one commit",
      );
    } catch {
      ui.line(
        ui.yellow("  git failed (is it installed, with a user.name and user.email?): skipped"),
      );
    }
  const dir = relative(process.cwd(), target) || ".";
  ui.line();
  ui.line(`${ui.green("Done.")} ${ui.bold(target)}`);
  ui.line();
  ui.line(
    `Run ${ui.cyan(`cd ${dir}`)}${o.skipInstall ? `, ${ui.cyan(`${pm} install`)}` : ""} and ${ui.cyan(runCommand(pm, "dev"))}: it indexes from ${startBlock === undefined ? "the config's start block" : `block ${startBlock.toLocaleString("en")}`}, follows the head and restarts on every change.`,
  );
  ui.line(`GraphiQL at ${ui.cyan("http://localhost:42069/graphql")} once it runs.`);
  if (rpc === PUBLIC_RPC) {
    ui.line();
    ui.line(ui.yellow(`${PUBLIC_RPC_NOTE} It's KASBAH_RPC_URL in .env.`));
  }
}

/** Whether `dir` is inside a git work tree already: a project in a monorepo stays part of it. */
async function insideRepository(dir: string): Promise<boolean> {
  try {
    await promisify(execFile)("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}
