import { homedir } from "node:os";
import pg from "pg";
import { type CacheInfo, listSchemas, type SchemaInfo } from "../../indexer/schemas.ts";
import { type DevDatabaseInfo, devUrl, listDevDatabases } from "../devdb.ts";
import { ago, colors, size, table } from "../ui/table.ts";

/**
 * `kasbah list`: the app schemas and event caches in `DATABASE_URL` (or `--database`), else in each running dev
 * container; then the dev databases on the machine, the containers `dev` made. Each largest first.
 */
export async function list(o: { database?: string }) {
  const color = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
  const database = o.database ?? process.env.DATABASE_URL;
  const out: string[] = [];
  const schemasIn = async (url: string, name: string, prune: boolean) => {
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      const { schemas, caches } = await listSchemas(pool);
      out.push(...renderSchemas(schemas, caches, name, { color, prune }), "");
    } finally {
      await pool.end();
    }
  };
  if (database !== undefined) await schemasIn(database, where(database), true);
  const found = listDevDatabases();
  if (found === undefined) {
    if (database === undefined)
      out.push("no DATABASE_URL, and no Docker or Podman for dev databases");
    return void console.log(out.join("\n").trimEnd());
  }
  if (database === undefined)
    for (const d of found.databases)
      if (d.port !== undefined) await schemasIn(devUrl(d.port), d.container, false);
  if (database === undefined || found.databases.length > 0)
    out.push(
      ...renderList(found.databases, found.runtime, {
        color,
        home: homedir(),
        stoppedHint: database === undefined,
      }),
    );
  console.log(out.join("\n").trimEnd());
}

/** The database's host, port and name, never its user or password. */
export function where(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return "DATABASE_URL";
  }
}

/** The app schemas and event caches of one database. */
export function renderSchemas(
  schemas: readonly SchemaInfo[],
  caches: readonly CacheInfo[],
  database: string,
  {
    color = false,
    now = Date.now(),
    prune = true,
  }: {
    color?: boolean;
    now?: number;
    /** Point at `kasbah prune` for the stopped ones: not in a dev container, which `clean` deletes. */
    prune?: boolean;
  } = {},
): string[] {
  const { dim, green } = colors(color);
  const cacheNotes = caches.map(
    (c) => `event cache ${c.chain}: ${size(c.bytes)}, shared by its apps`,
  );
  if (schemas.length === 0)
    return [`no app schemas in ${database}`, ...cacheNotes.map((n) => `  ${n}`)];
  const total = schemas.reduce((s, x) => s + x.bytes, 0);
  const running = schemas.filter((s) => s.running).length;
  const stopped = schemas.length - running;
  return [
    ...table({
      title: "schemas",
      right: database,
      color,
      columns: [
        { title: "SCHEMA" },
        { title: "STATE" },
        { title: "BY" },
        { title: "PHASE" },
        { title: "BLOCK", right: true },
        { title: "TABLES", right: true },
        { title: "SIZE", right: true },
        { title: "LAST ACTIVE" },
      ],
      rows: schemas.map((s) => ({
        cells: [
          s.schema,
          s.running ? "running" : "stopped",
          s.dev === undefined ? "-" : s.dev ? "dev" : "start",
          s.phase ?? "-",
          s.block === undefined ? "-" : s.block.toLocaleString("en-US"),
          String(s.tables),
          size(s.bytes),
          s.running ? "now" : s.lastActive === undefined ? "-" : ago(s.lastActive, now),
        ],
        style: (i, p) => (i === 1 ? (s.running ? green(p) : dim(p)) : p),
      })),
      notes: [
        `${schemas.length} ${schemas.length === 1 ? "schema" : "schemas"} · ${running} running · ${size(total)}`,
        ...cacheNotes,
      ],
    }),
    ...(stopped === 0 || !prune
      ? []
      : [
          dim(
            `drop the stopped ${stopped === 1 ? "one" : "ones"} with \`kasbah prune\` (the cache stays)`,
          ),
        ]),
  ];
}

/** The dev databases on the machine. */
export function renderList(
  databases: readonly DevDatabaseInfo[],
  runtime: string,
  {
    color = false,
    home = "",
    stoppedHint = false,
  }: {
    color?: boolean;
    home?: string;
    /** Say how to see a stopped container's schemas (only running ones are read). */
    stoppedHint?: boolean;
  } = {},
): string[] {
  const { dim, green } = colors(color);
  if (databases.length === 0)
    return [
      `no dev databases (${runtime}): \`kasbah dev\` makes one for an app without DATABASE_URL`,
    ];
  const shortHome = (dir: string) =>
    home !== "" && (dir === home || dir.startsWith(`${home}/`))
      ? `~${dir.slice(home.length)}`
      : dir;
  const total = databases.reduce((s, d) => s + (d.bytes ?? 0), 0);
  const running = databases.filter((d) => d.running).length;
  return [
    ...table({
      title: "dev databases",
      right: runtime,
      color,
      columns: [
        { title: "CONTAINER" },
        { title: "STATE" },
        { title: "PORT", right: true },
        { title: "SIZE", right: true },
        { title: "APP" },
      ],
      rows: databases.map((d) => ({
        cells: [
          d.container,
          d.running ? "running" : "stopped",
          d.port ?? "-",
          d.bytes === undefined ? "?" : size(d.bytes),
          d.app === undefined ? "-" : shortHome(d.app),
        ],
        style: (i, p) =>
          i === 1 ? (d.running ? green(p) : dim(p)) : i === 4 && d.app === undefined ? dim(p) : p,
      })),
      notes: [
        `${databases.length} ${databases.length === 1 ? "database" : "databases"} · ${running} running · ${size(total)}`,
      ],
    }),
    ...(stoppedHint && databases.some((d) => !d.running)
      ? [dim("a stopped one's schemas show while it runs (`kasbah dev` in its app)")]
      : []),
    dim("delete one with `kasbah clean` in its app directory"),
  ];
}
