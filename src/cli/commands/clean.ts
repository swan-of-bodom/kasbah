import { dirname, resolve } from "node:path";
import { ConfigError } from "../../config/errors.ts";
import { removeDevDatabase } from "../devdb.ts";
import { load } from "../project.ts";
import { Prompt } from "../ui/prompt.ts";

/** The dev container and volume when `dev` made them, else only the app's schema in DATABASE_URL. */
export async function clean(file: string, yes: boolean | undefined) {
  if (process.env.DATABASE_URL === undefined) {
    const r = removeDevDatabase(dirname(resolve(file)));
    console.log(
      r.removed
        ? `deleted ${r.container} and its volume (${r.runtime}); the next dev starts from scratch`
        : `nothing to delete: no ${r.container}`,
    );
    return;
  }
  const app = await load(file);
  if (!yes) {
    if (!process.stdin.isTTY)
      throw new ConfigError("clean drops the app's schema in DATABASE_URL: pass --yes to confirm");
    const ok = await new Prompt().confirm(
      "Drop this app's schema in DATABASE_URL (its tables and progress)?",
      false,
    );
    if (!ok) return void console.log("kept");
  }
  console.log(`dropped schema ${await app.drop()}; the next start indexes from scratch`);
}
