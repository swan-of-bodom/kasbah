import { Status } from "../../indexer/status.ts";
import { load, sourceHash } from "../project.ts";
import { Screen } from "../ui/dashboard.ts";

export async function start(
  file: string,
  o: { to?: number; reset?: boolean; dev?: boolean; ui?: boolean; debug?: boolean },
) {
  const status = (o.ui ?? (o.dev && process.stdout.isTTY)) ? new Status() : undefined;
  if (status !== undefined) status.debug = o.debug === true;
  const screen = status === undefined ? undefined : new Screen(status);
  screen?.start();
  try {
    const app = await load(file, { schemaRequired: !o.dev });
    const stop = new AbortController();
    // Ctrl-C reaches this process twice under `kasbah dev` (from the terminal, then from the parent), so a repeat
    // must not kill it before the last commit; a third one does.
    let signals = 0;
    for (const s of ["SIGINT", "SIGTERM"] as const)
      process.on(s, () => (++signals >= 3 ? process.exit(130) : stop.abort()));
    await app.run({
      to: o.to,
      reset: o.reset,
      signal: stop.signal,
      onBuildChange: o.dev ? "reset" : "error",
      buildSalt: sourceHash(file),
      status,
    });
  } finally {
    screen?.stop();
  }
}
