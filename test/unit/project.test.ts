import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { sourceHash } from "../../src/cli/project.ts";

test("the source hash follows the app's code, not its package.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "kasbah-hash-"));
  try {
    const app = join(dir, "kasbah.config.ts");
    writeFileSync(app, "export default 1;\n");
    writeFileSync(join(dir, "package.json"), '{"dependencies":{"kasbah":"0.1.0"}}');
    const before = sourceHash(app);
    writeFileSync(join(dir, "package.json"), '{"dependencies":{"kasbah":"0.1.1"}}');
    expect(sourceHash(app)).toBe(before);
    writeFileSync(join(dir, "src.ts"), "export const x = 1;\n");
    expect(sourceHash(app)).not.toBe(before);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
