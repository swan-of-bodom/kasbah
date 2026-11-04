import { expect, test } from "vitest";
import { renderList } from "../../src/cli/commands/list.ts";
import { parseSize, volumeSizes } from "../../src/cli/devdb.ts";

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
