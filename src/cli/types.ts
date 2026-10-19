/**
 * The contract between the command registry and the commands.
 *
 * The registry loads the command modules lazily and the commands
 * describe themselves with this interface. The type lives in its own
 * module so that the registry and the commands do not have to import
 * each other: a value import would close a real ESM cycle, and a type
 * import would only hide it.
 */

/** The executable part of a command. */
export interface CommandImplementation<TOptions = unknown> {
  /** Parse argv into the command's options; throws on a usage error. */
  parse(argv: readonly string[]): TOptions;
  /** Run the command; returns the process exit code. */
  run(options: TOptions): Promise<number>;
}
