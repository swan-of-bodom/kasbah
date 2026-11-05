import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { mainHelp } from "../../src/cli/help.ts";

test("the README shows kasbah --help exactly as it prints", () => {
  expect(readFileSync("README.md", "utf8")).toContain(`\`\`\`\n${mainHelp()}\n\`\`\``);
});
