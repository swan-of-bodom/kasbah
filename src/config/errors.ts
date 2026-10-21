/**
 * A mistake to fix in the config, the flags, the environment or a handler's use of the API: its message says what,
 * so the CLI prints it without a stack.
 */
export class ConfigError extends Error {
  override name = "ConfigError";
}
