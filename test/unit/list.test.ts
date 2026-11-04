import pg from "pg";
import { expect, test } from "vitest";
import { renderList, renderSchemas, where } from "../../src/cli/commands/list.ts";
import { parseSize, volumeSizes } from "../../src/cli/devdb.ts";
import { ago } from "../../src/cli/ui/table.ts";
import { LOCK } from "../../src/indexer/lock.ts";
import { chainName, dropStopped, listSchemas } from "../../src/indexer/schemas.ts";

const url = process.env.DATABASE_URL;

const PODMAN_DF = `Images space usage:

REPOSITORY                 TAG         IMAGE ID      CREATED      SIZE        SHARED SIZE  UNIQUE SIZE  CONTAINERS
docker.io/library/postgres 17          81edcaa5ff29  3 weeks ago  457MB       0B           457MB        2

Containers space usage:

CONTAINER ID  IMAGE         COMMAND     LOCAL VOLUMES  SIZE        CREATED     STATUS      NAMES
b06c0359e8c7  81edcaa5ff29  postgres    1              12.41kB     16 hours    exited      kasbah-ekubo-test-c13976

Local Volumes space usage:

VOLUME NAME                                                       LINKS       SIZE
kasbah-ekubo-test-c13976                                          1           65.08GB
04418d4f23a4f42f5ddbc2ad5da9c0398d21bab88c56832219054733c24bd374  1           21.18GB
empty                                                             0           0B
`;

const DOCKER_DF = `Local Volumes space usage:

VOLUME NAME                LINKS     SIZE
kasbah-erc20-1a2b3c        1         312.5MB

Build cache usage: 0B
`;

test("the volume sizes are read from Podman's and Docker's system df -v, in decimal units", () => {
  const podman = volumeSizes(PODMAN_DF);
  expect(podman.get("kasbah-ekubo-test-c13976")).toBe(65.08e9);
  expect(podman.get("empty")).toBe(0);
  expect(podman.has("b06c0359e8c7")).toBe(false);
  expect(volumeSizes(DOCKER_DF)).toEqual(new Map([["kasbah-erc20-1a2b3c", 312.5e6]]));
  expect(parseSize("12.41kB")).toBe(12_410);
  expect(parseSize("N/A")).toBeUndefined();
});

test("list shows each dev database with its state, port, size and app, home as ~, and the total", () => {
  const lines = renderList(
    [
      {
        container: "kasbah-ekubo-test-c13976",
        running: false,
        bytes: 65.08e9,
      },
      {
        container: "kasbah-erc20-1a2b3c",
        running: true,
        port: "40123",
        bytes: 312.5e6,
        app: "/home/me/apps/erc20",
      },
    ],
    "podman",
    { home: "/home/me" },
  );
  expect(lines).toEqual([
    "╭─ kasbah · dev databases ─────────────────────────────── podman ─╮",
    "│ CONTAINER                 STATE     PORT     SIZE  APP          │",
    "│ kasbah-ekubo-test-c13976  stopped      -  65.1 GB  -            │",
    "│ kasbah-erc20-1a2b3c       running  40123   313 MB  ~/apps/erc20 │",
    "│                                                                 │",
    "│ 2 databases · 1 running · 65.4 GB                               │",
    "╰─────────────────────────────────────────────────────────────────╯",
    "delete one with `kasbah clean` in its app directory",
  ]);
  expect(renderList([], "docker")).toEqual([
    "no dev databases (docker): `kasbah dev` makes one for an app without DATABASE_URL",
  ]);
});

test("list shows each schema's state, phase, block, size and last activity, and the caches below", () => {
  const now = Date.UTC(2026, 10, 4, 12);
  const lines = renderSchemas(
    [
      {
        schema: "ekubo_1a2b3c",
        running: true,
        dev: false,
        phase: "live",
        block: 4_812_003,
        lastActive: now - 3_000,
        tables: 11,
        bytes: 38.2e9,
      },
      {
        schema: "ekubo_0c0ffe",
        running: false,
        dev: false,
        phase: "backfill",
        block: 701_200,
        lastActive: now - 2 * 86_400_000,
        tables: 11,
        bytes: 9.6e9,
      },
      { schema: "old", running: false, tables: 0, bytes: 8_192 },
    ],
    [{ schema: "kasbah_cache_0x534e5f4d41494e", chain: "SN_MAIN", bytes: 23.7e9 }],
    "db.example:5432/railway",
    { now },
  );
  expect(lines).toEqual([
    "╭─ kasbah · schemas ──────────────────────────────────── db.example:5432/railway ─╮",
    "│ SCHEMA        STATE    BY     PHASE         BLOCK  TABLES     SIZE  LAST ACTIVE │",
    "│ ekubo_1a2b3c  running  start  live      4,812,003      11  38.2 GB  now         │",
    "│ ekubo_0c0ffe  stopped  start  backfill    701,200      11   9.6 GB  2 days ago  │",
    "│ old           stopped  -      -                 -       0     8 kB  -           │",
    "│                                                                                 │",
    "│ 3 schemas · 1 running · 47.8 GB                                                 │",
    "│ event cache SN_MAIN: 23.7 GB, shared by its apps                                │",
    "╰─────────────────────────────────────────────────────────────────────────────────╯",
    "drop the stopped ones with `kasbah prune` (the cache stays)",
  ]);
});

test("the database is named by host and name, never with its password", () => {
  expect(where("postgresql://user:secret@db.example:5432/railway")).toBe("db.example:5432/railway");
  expect(where("not a url")).toBe("DATABASE_URL");
});

test("ages read as now, minutes, hours or days; a chain id as its name when it spells one", () => {
  const now = 1_000_000_000;
  expect(
    [30e3, 5 * 60e3, 3 * 3600e3, 86_400e3, 9 * 86_400e3].map((d) => ago(now - d, now)),
  ).toEqual(["now", "5 min ago", "3 h ago", "1 day ago", "9 days ago"]);
  expect(chainName("0x534e5f4d41494e")).toBe("SN_MAIN");
  expect(chainName("0x7e57")).toBe("0x7e57");
});

test.skipIf(url === undefined)(
  "list finds every app schema by its meta table; prune drops a stopped one and keeps a running one and the cache",
  async () => {
    const pool = new pg.Pool({ connectionString: url, max: 2 });
    const live = "list_test_live";
    const dead = "list_test_dead";
    const cache = "kasbah_cache_0x6c697374";
    const drop = () =>
      pool.query(
        `DROP SCHEMA IF EXISTS ${live} CASCADE; DROP SCHEMA IF EXISTS ${dead} CASCADE; DROP SCHEMA IF EXISTS ${cache} CASCADE`,
      );
    const app = async (schema: string, lock: object) => {
      await pool.query(`CREATE SCHEMA ${schema}`);
      await pool.query(
        `CREATE TABLE ${schema}._kasbah_meta (key text PRIMARY KEY, value jsonb NOT NULL)`,
      );
      await pool.query(`CREATE TABLE ${schema}.swaps (id text PRIMARY KEY)`);
      await pool.query(
        `INSERT INTO ${schema}._kasbah_meta VALUES ('lock', $1), ('phase', '"live"'), ('checkpoint', '1234')`,
        [JSON.stringify(lock)],
      );
    };
    try {
      await drop();
      const now = Date.now();
      await app(live, { owner: "a", heartbeat: now, dev: false });
      await app(dead, { owner: "b", heartbeat: now - LOCK.timeoutMs - 1_000, dev: true });
      await pool.query(`CREATE SCHEMA ${cache}; CREATE TABLE ${cache}.events (n int)`);

      const { schemas, caches } = await listSchemas(pool, now);
      const mine = schemas.filter((s) => s.schema.startsWith("list_test_"));
      expect(
        mine.map(({ bytes: _, ...s }) => s).sort((a, b) => a.schema.localeCompare(b.schema)),
      ).toEqual([
        {
          schema: dead,
          running: false,
          dev: true,
          phase: "live",
          block: 1234,
          lastActive: now - LOCK.timeoutMs - 1_000,
          tables: 1,
        },
        {
          schema: live,
          running: true,
          dev: false,
          phase: "live",
          block: 1234,
          lastActive: now,
          tables: 1,
        },
      ]);
      expect(caches.find((c) => c.schema === cache)?.chain).toBe("list");

      expect(await dropStopped(pool, [live, dead])).toEqual([dead]);
      const left = (
        await pool.query<{ n: string }>(
          `SELECT nspname AS n FROM pg_namespace WHERE nspname = ANY($1)`,
          [[live, dead, cache]],
        )
      ).rows.map((r) => r.n);
      expect(left.sort()).toEqual([cache, live].sort());
    } finally {
      await drop();
      await pool.end();
    }
  },
);

test.skipIf(url === undefined)(
  "a schema dropped while list reads it is left out, not an error",
  async () => {
    const pool = new pg.Pool({ connectionString: url, max: 2 });
    const gone = "list_test_gone";
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${gone} CASCADE; CREATE SCHEMA ${gone}`);
      await pool.query(
        `CREATE TABLE ${gone}._kasbah_meta (key text PRIMARY KEY, value jsonb NOT NULL)`,
      );
      // Another process drops it right after list found it.
      let first = true;
      const racing = {
        query: async (...args: Parameters<pg.Pool["query"]>) => {
          const r = await (pool.query as (...a: unknown[]) => Promise<unknown>)(...args);
          if (first) {
            first = false;
            await pool.query(`DROP SCHEMA ${gone} CASCADE`);
          }
          return r;
        },
      } as unknown as pg.Pool;
      const { schemas } = await listSchemas(racing);
      expect(schemas.map((s) => s.schema)).not.toContain(gone);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${gone} CASCADE`);
      await pool.end();
    }
  },
);

test("in a dev container, list doesn't point at prune, and says a stopped container's schemas need it running", () => {
  const stopped = { schema: "app", running: false, tables: 1, bytes: 1e6 };
  expect(renderSchemas([stopped], [], "kasbah-app-1a2b3c", { prune: false }).at(-1)).toMatch(/^╰/);
  const lines = renderList([{ container: "kasbah-app-1a2b3c", running: false }], "podman", {
    stoppedHint: true,
  });
  expect(lines.at(-2)).toBe("a stopped one's schemas show while it runs (`kasbah dev` in its app)");
});
