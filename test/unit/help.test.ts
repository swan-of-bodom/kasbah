import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { COMMANDS } from "../../src/cli/help.ts";

test("the README lists every command with the summary kasbah --help prints", () => {
  const rows = new Set(
    readFileSync("README.md", "utf8")
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim()),
  );
  for (const [name, { summary }] of Object.entries(COMMANDS)) {
    expect(rows, `the README's commands table has no row for ${name}`).toContain(
      `| \`${name}\` | ${summary} |`,
    );
  }
});
