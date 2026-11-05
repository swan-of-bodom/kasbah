import { TEMPLATES } from "./commands/init.ts";

/**
 * A command's help: its line in `kasbah --help`, what it does, how it's called, and its arguments and options, each
 * with a description.
 */
type Help = {
  summary: string;
  about: string;
  usage: string;
  args?: [string, string][];
  options: [string, string][];
};

const DOCS = "https://swan-of-bodom.github.io/kasbah/";

const APP: [string, string] = [
  "[app.ts]",
  "The app (default: the project here: kasbah.config.ts, src/index.ts and src/api/index.ts)",
];
const SCHEMA: [string, string] = [
  "--schema <name>",
  "The Postgres schema (DATABASE_SCHEMA; default: the config's, else the directory's name)",
];
const DEPLOY_SCHEMA: [string, string] = [
  "--schema <name>",
  "The Postgres schema, a new one per deploy (DATABASE_SCHEMA; default: the config's, else required)",
];
const PORT: [string, string] = ["--port <n>", "Where the API listens (PORT; default: 42069)"];
const HOSTNAME: [string, string] = [
  "--hostname <host>",
  "The host it listens on (API_HOST; default: localhost)",
];
const UI: [string, string] = [
  "--ui / --no-ui",
  "The progress screen (default: on for dev in a terminal)",
];
const DEBUG: [string, string] = [
  "--debug",
  "With the screen: the fetcher's buffer and windows, waits, event loop delay",
];
const DATABASE: [string, string] = [
  "--database <url>",
  "The Postgres to use instead of DATABASE_URL",
];
const YES: [string, string] = ["-y, --yes", "Don't ask first"];
const HELP: [string, string] = ["-h, --help", "Print help"];

/** Every command's help, in the order `kasbah --help` lists them. */
export const COMMANDS = {
  init: {
    summary: "Create a project from a contract address or a template",
    about:
      "Create a project from a contract address or a template: asks for the directory, what to start from, the RPC\nand Postgres, then installs the packages and makes a git repository. `pnpm create kasbah` runs it.",
    usage: "kasbah init [dir] [options]   (or pnpm create kasbah [dir] [options])",
    options: [
      ["-t, --template <name>", "Start from a template (mainnet):"],
      ...Object.entries(TEMPLATES).map(([name, about]): [string, string] => [
        "",
        `  ${name.padEnd(9)} ${about}`,
      ]),
      [
        "--address <0x…>",
        "Or from a contract: its ABI and deployment block are read from the chain",
      ],
      ["  --name <Name>", "Its name in the app (handlers are <Name>:<Event>)"],
      ["  --handle <A,B>", "The events to index (default: all)"],
      ["  --start <block>", "The first block (default: its deployment)"],
      ["  --timestamps", "Store each event's block timestamp (one call per block with events)"],
      ["--rpc <url>", "A spec 0.10 RPC (default: KASBAH_RPC_URL, else a free public one)"],
      ["--database <url>", "Postgres (empty: `dev` runs one in a container)"],
      ["--no-ws", "Poll for new blocks instead of a WebSocket"],
      ["--npm, --pnpm, --yarn", "The package manager (default: the one running create, else pnpm)"],
      ["--skip-install", "Don't install the packages"],
      ["--skip-git", "Don't make a git repository"],
      ["-y, --yes", "Take the defaults, ask nothing"],
      HELP,
      ["-v, --version", "Print the version"],
    ],
  },
  dev: {
    summary: "Index and serve, restarting on every file change",
    about:
      "Index and serve, restarting on every file change. A changed build re-indexes. Without DATABASE_URL, Postgres\nruns in a Docker or Podman container for the app, stopped (data kept) when dev exits.",
    usage: "kasbah dev [app.ts] [options]",
    args: [APP],
    options: [
      ["--reset", "Drop what it stored and start over (pnpm fresh)"],
      SCHEMA,
      PORT,
      HOSTNAME,
      UI,
      DEBUG,
      HELP,
    ],
  },
  start: {
    summary: "Index and serve, for production",
    about:
      "Index and serve, for production: backfills, then follows the head until --to or Ctrl-C. Needs DATABASE_URL\nand a schema; one indexer runs per schema at a time.",
    usage: "kasbah start [app.ts] [options]",
    args: [APP],
    options: [
      ["--to <block>", "Stop at this block"],
      ["--reset", "Drop what it stored and start over"],
      DEPLOY_SCHEMA,
      PORT,
      HOSTNAME,
      UI,
      DEBUG,
      HELP,
    ],
  },
  serve: {
    summary: "Serve the API alone, over what an indexer stored",
    about:
      "Serve the API alone, over what an indexer of the app stored: more API processes than indexers, or a\nfinished run.",
    usage: "kasbah serve [app.ts] [options]",
    args: [APP],
    options: [DEPLOY_SCHEMA, PORT, HOSTNAME, HELP],
  },
  clean: {
    summary: "Delete what the app stored",
    about:
      "Delete what the app stored: the dev container and its volume, or with DATABASE_URL only the app's schema.\nAsks first. The event cache stays.",
    usage: "kasbah clean [app.ts] [options]",
    args: [APP],
    options: [SCHEMA, YES, HELP],
  },
  list: {
    summary: "Show the app schemas, event caches and dev databases",
    about:
      "Show the app schemas in DATABASE_URL (running or not, phase, last block, size, last active) and the event\ncaches, then every dev database on the machine, with its port, size and app directory.",
    usage: "kasbah list [options]",
    options: [DATABASE, HELP],
  },
  prune: {
    summary: "Drop the schemas no indexer is running",
    about:
      "Drop every app schema in DATABASE_URL that no indexer is running. Lists them and asks first. The event\ncaches stay, so a new deploy re-indexes without fetching again.",
    usage: "kasbah prune [options]",
    options: [DATABASE, YES, HELP],
  },
  cache: {
    summary: "Empty the raw-event and call caches",
    about: "Empty the raw-event and call caches, per chain (kasbah list shows their sizes).",
    usage: "kasbah cache clear [options]",
    options: [
      ["--events", "The event cache (default: both)"],
      ["--calls", "The call cache (default: both)"],
      ["--chain <id>", "Only this chain's (default: every chain's)"],
      DATABASE,
      HELP,
    ],
  },
} satisfies Record<string, Help>;

export type Command = keyof typeof COMMANDS;

export const isCommand = (name: string): name is Command => Object.hasOwn(COMMANDS, name);

/** `kasbah`, `kasbah --help` and `kasbah help`: every command, one line each. */
export function mainHelp(): string {
  const commands: [string, string][] = Object.entries(COMMANDS).map(([name, h]) => [
    name,
    h.summary,
  ]);
  commands.push(["help", "Print this, or a command's help (kasbah help <command>)"]);
  return [
    "A minimal, fast Starknet indexer in TypeScript.",
    "",
    "Usage: kasbah <command> [options]",
    "",
    "Commands:",
    ...table(commands),
    "",
    "Options:",
    ...table([
      ["-h, --help", "Print help (kasbah <command> --help for a command's options)"],
      ["-v, --version", "Print the version"],
    ]),
    "",
    `Reads .env from the working directory. Docs: ${DOCS}`,
  ].join("\n");
}

/** `kasbah <command> --help` and `kasbah help <command>`. */
export function commandHelp(command: Command): string {
  const h: Help = COMMANDS[command];
  return [
    h.about,
    "",
    `Usage: ${h.usage}`,
    ...(h.args === undefined ? [] : ["", "Arguments:", ...table(h.args)]),
    "",
    "Options:",
    ...table(h.options),
  ].join("\n");
}

/** Rows as two aligned columns, indented two spaces. */
function table(rows: [string, string][]): string[] {
  const width = Math.max(...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`.trimEnd());
}
