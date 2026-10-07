import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";

const root = join(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "kasbah-pkg-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("the packed package installs and works outside the repo: library, types and the kasbah command", () => {
  const pnpm = (args: string[], cwd: string) => execFileSync("pnpm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  pnpm(["pack", "--pack-destination", dir], root);
  const tarball = readdirSync(dir).find((f) => f.endsWith(".tgz"))!;
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module", dependencies: { kasbah: `file:./${tarball}`, "drizzle-orm": "^0.45.4" } }));
  // The repo's store: pnpm keeps one per filesystem, and the temp dir may be on another (tmpfs).
  pnpm(["install", "--offline", "--store-dir", pnpm(["store", "path"], root).trim()], dir);

  // Plain JavaScript inside node_modules: no type stripping needed.
  const imported = execFileSync(process.execPath, ["--input-type=module", "-e", `const m = await import("kasbah"); console.log(typeof m.kasbah, typeof m.bignum, typeof m.Status)`], { cwd: dir, encoding: "utf8" });
  expect(imported.trim()).toBe("function function function");
  expect(readdirSync(join(dir, "node_modules/kasbah/dist"))).toContain("index.d.ts");
  expect(execFileSync(join(dir, "node_modules/.bin/kasbah"), ["--help"], { cwd: dir, encoding: "utf8" })).toContain("kasbah start <app.ts>");
}, 120_000);
