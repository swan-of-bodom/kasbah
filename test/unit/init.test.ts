import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { Abi } from "../../src/abi/abi.ts";
import { generate, TEMPLATES, type Template, templateFiles } from "../../src/cli/commands/init.ts";

const abi = [
  { type: "struct", name: "x::Key", members: [{ name: "a", type: "core::felt252" }] },
  {
    type: "event",
    name: "x::Pool::Moved",
    kind: "struct",
    members: [
      { name: "block", type: "core::integer::u64", kind: "key" },
      { name: "who", type: "core::starknet::contract_address::ContractAddress", kind: "data" },
      { name: "key", type: "x::Key", kind: "data" },
      { name: "ok", type: "core::bool", kind: "data" },
    ],
  },
  {
    type: "event",
    name: "x::Pool::Event",
    kind: "enum",
    variants: [{ name: "Moved", type: "x::Pool::Moved", kind: "nested" }],
  },
] as const satisfies Abi;

const files = generate({
  dir: "/x/pools",
  rpc: "http://rpc",
  network: "mainnet",
  database: "postgres://db",
  name: "Pool",
  address: "0x1",
  abi,
  startBlock: 7,
  events: ["Moved"],
  timestamps: false,
  ws: true,
  dependency: "^0.0.0",
});

test("the layout: config, schema, ABI, handlers, routes", () => {
  expect(Object.keys(files).slice(0, 5)).toEqual([
    "kasbah.config.ts",
    "kasbah.schema.ts",
    "abis/Pool.ts",
    "src/index.ts",
    "src/api/index.ts",
  ]);
  expect(files["kasbah.config.ts"]).toContain(
    `Pool: { abi: poolAbi, address: "0x1", startBlock: 7 },`,
  );
  expect(files["kasbah.config.ts"]).toContain(`import poolAbi from "./abis/Pool.ts";`);
  expect(files["kasbah.config.ts"]).toContain("  ws: true,\n");
  // What the layout gives (schema from the directory, tables from kasbah.schema.ts, the API on) isn't written.
  expect(files["kasbah.config.ts"]).toContain(`  network: "mainnet",\n`);
  for (const gone of ["schema", "tables", "api:", "database"])
    expect(files["kasbah.config.ts"]).not.toContain(gone);
  expect(files["src/index.ts"]).toContain(`import app from "../kasbah.config.ts";`);
  expect(files["src/api/index.ts"]).toContain(`app.get("/moved/latest"`);
  expect(files["src/api/index.ts"]).toContain(`app.use("/graphql", graphql({ db, schema }));`);
  expect(JSON.parse(files["package.json"]!).dependencies.hono).toMatch(/^\^4\./);
  expect(JSON.parse(files["package.json"]!).scripts).toMatchObject({
    dev: "kasbah dev",
    fresh: "kasbah dev --reset",
    clean: "kasbah clean",
  });
});

test("one table per event, arguments as typed columns, structs as jsonb", () => {
  expect(files["kasbah.schema.ts"]).toContain(`export const moved = pgTable("moved", {`);
  expect(files["kasbah.schema.ts"]).toMatch(
    /block_: bignum\(\)\.notNull\(\),\n {2}who: hex\(\)\.notNull\(\),\n {2}key: jsonb\(\),\n {2}ok: boolean\(\)\.notNull\(\),/,
  );
  expect(files["kasbah.schema.ts"]).not.toContain("timestamp");
  expect(files["src/index.ts"]).toContain(`app.on("Pool:Moved"`);
  expect(files["src/index.ts"]).toContain("block_: event.args.block,");
  expect(files["src/index.ts"]).toContain("key: event.args.key,");
  expect(files["src/index.ts"]).not.toContain("plain");
});

test("the compose file indexes into the project's schema, and every placeholder is filled", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: compose's variable, written as is
  expect(files["docker-compose.yml"]).toContain("DATABASE_SCHEMA: ${DATABASE_SCHEMA:-pools}");
  expect(files.Dockerfile).toContain("RUN pnpm install");
  for (const content of Object.values(files)) expect(content).not.toMatch(/\{\{\w+\}\}/);
});

test("secrets only in .env, which git and Docker ignore; .env.example has the names", () => {
  expect(files[".env"]).toBe("KASBAH_RPC_URL=http://rpc\nDATABASE_URL=postgres://db\n");
  expect(files[".env.example"]).toMatch(/^KASBAH_RPC_URL=https:\/\/.*<key>\n# DATABASE_URL=/);
  expect(files[".gitignore"]).toContain(".env\n");
  expect(files[".dockerignore"]).toContain(".env\n");
  for (const [path, content] of Object.entries(files))
    if (path !== ".env") expect(content).not.toContain("http://rpc");
});

test.each(Object.keys(TEMPLATES) as Template[])(
  "the %s template is written as templates/ has it, importing kasbah by name, with the project's files around it",
  (template) => {
    const written = templateFiles(template, {
      dir: "/x/mine",
      rpc: "http://rpc",
      database: undefined,
      dependency: "^0.0.0",
    });
    const root = join("templates", template);
    const own = (readdirSync(root, { recursive: true }) as string[]).filter((f) =>
      statSync(join(root, f)).isFile(),
    );
    expect(own).toEqual(
      expect.arrayContaining(["kasbah.config.ts", "kasbah.schema.ts", "src/index.ts"]),
    );
    for (const f of own) {
      const content = readFileSync(join(root, f), "utf8");
      expect(written[f]).toBe(content);
      // A relative import into this repo would break once the project is outside it.
      expect(content).not.toMatch(/from "(\.\.\/)+src\//);
    }
    expect(JSON.parse(written["package.json"]!).dependencies).toEqual({
      kasbah: "^0.0.0",
      hono: "^4.13.0",
    });
    expect(written["README.md"]).toContain(TEMPLATES[template]);
    expect(written[".env"]).toContain("KASBAH_RPC_URL=http://rpc\n# DATABASE_URL=");
  },
);

test("the project is written for its package manager: npm runs scripts with run, yarn installs into node_modules", () => {
  const common = { dir: "/x/mine", rpc: "http://rpc", database: undefined, dependency: "^0.0.0" };
  const pnpm = templateFiles("ekubo", common);
  expect(JSON.parse(pnpm["package.json"]!).packageManager).toMatch(/^pnpm@/);
  expect(pnpm.Dockerfile).toContain("RUN pnpm install");
  expect(pnpm["README.md"]).toContain("pnpm start --schema mine");

  const npm = templateFiles("ekubo", { ...common, packageManager: "npm" });
  expect(JSON.parse(npm["package.json"]!).packageManager).toBe(undefined);
  expect(npm.Dockerfile).toContain("RUN npm install");
  expect(npm.Dockerfile).not.toContain("pnpm");
  expect(npm["README.md"]).toContain("npm run start -- --schema mine");

  const yarn = templateFiles("ekubo", { ...common, packageManager: "yarn" });
  expect(yarn[".yarnrc.yml"]).toBe("nodeLinker: node-modules\n");
  expect(yarn.Dockerfile).toContain("RUN corepack enable");
  expect(yarn["README.md"]).toContain("yarn dev");
});

test("the public RPC comes with a note in .env to replace it; a given one doesn't", () => {
  const common = { dir: "/x/mine", database: undefined, dependency: "^0.0.0" };
  const env = (rpc: string) => templateFiles("erc20", { ...common, rpc })[".env"]!;
  expect(env("https://starknet-rpc.publicnode.com")).toMatch(
    /^# A free public RPC, to try kasbah: replace it with a provider's \(Alchemy.*\nKASBAH_RPC_URL=https:\/\/starknet-rpc\.publicnode\.com\n/,
  );
  expect(env("http://rpc")).toMatch(/^KASBAH_RPC_URL=http:\/\/rpc\n/);
});
