/** Work cut short by the run's stop signal (Ctrl-C): a stop, not a failure. */
export class Stopped extends Error {
  constructor() {
    super("stopped");
    this.name = "Stopped";
  }
}

/** The `code` of a Node or Postgres error (`ENOENT`, `23505`, …), if it has one. */
export const errorCode = (e: unknown): string | undefined =>
  typeof (e as { code?: unknown })?.code === "string" ? (e as { code: string }).code : undefined;
