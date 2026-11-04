import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { sourceHash } from "../../src/cli/project.ts";

const folder = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "kasbah-hash-"));
  const write = (name: string, text: string) => {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  };
  for (const [name, text] of Object.entries(files)) write(name, text);
  return { dir, write };
};

test("a project's source hash follows src/ but its API and tests, not the config's text or package.json", () => {
  const { dir, write } = folder({
    "kasbah.config.ts": "export default 1;\n",
    "package.json": '{"dependencies":{"kasbah":"0.1.0"}}',
    "src/index.ts": "export {};\n",
    "src/api/index.ts": "export default 1;\n",
  });
  try {
    const config = join(dir, "kasbah.config.ts");
    const before = sourceHash(config);
    write("package.json", '{"dependencies":{"kasbah":"0.1.1"}}');
    write("kasbah.config.ts", "export default 2; // another RPC\n");
    write("src/api/index.ts", "export default 2;\n");
    write("src/api/routes/pools.ts", "export const r = 1;\n");
    write("src/index.test.ts", "export {};\n");
    write("scripts/check.ts", "export {};\n");
    expect(sourceHash(config)).toBe(before);
    write("src/utils/price.ts", "export const x = 1;\n");
    expect(sourceHash(config)).not.toBe(before);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("a single-file app's source hash follows every code file beside it, not its package.json", () => {
  const { dir, write } = folder({
    "app.ts": "export default 1;\n",
    "package.json": '{"dependencies":{"kasbah":"0.1.0"}}',
  });
  try {
    const app = join(dir, "app.ts");
    const before = sourceHash(app);
    write("package.json", '{"dependencies":{"kasbah":"0.1.1"}}');
    expect(sourceHash(app)).toBe(before);
    write("helper.ts", "export const x = 1;\n");
    expect(sourceHash(app)).not.toBe(before);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
