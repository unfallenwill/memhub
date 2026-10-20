/**
 * Shared option parsing for the CLI.
 *
 * Every command parses its flags through the helpers in this module, so
 * a usage error always reads the same way: "invalid --port value: 0"
 * or "--title requires a value". The port check and the "flag needs a
 * value" check exist exactly once - a command that grows a new flag
 * never invents a third wording.
 */

/** Parse a --port value. Throws on anything that is not a valid TCP port. */
export function parsePortValue(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`invalid --port value: ${value ?? '(missing)'}`);
  }
  return parsed;
}

/** Require a non-empty value for a flag. Throws when it is missing or empty. */
export function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined || value === '') {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

/**
 * One flag the generic parser understands.
 *
 * A flag without `takesValue` is a switch ("--foreground"); a flag with
 * it consumes the next argument ("--port 7800").
 */
export interface FlagSpec {
  /** The canonical spelling, e.g. '--port'. */
  readonly name: string;
  /** Alternative spellings, e.g. '-p'. */
  readonly aliases?: readonly string[];
  /** True when the flag consumes the next argument as its value. */
  readonly takesValue?: boolean;
}

/** The --port flag (with its short form), shared by several commands. */
export const PORT_FLAG: FlagSpec = { name: '--port', aliases: ['-p'], takesValue: true };

/** One argument as the generic parser saw it. */
export interface FlagEntry {
  /**
   * The canonical name of the flag, or undefined when the argument is
   * not a known flag.
   */
  readonly name: string | undefined;
  /** The value that followed the flag; undefined when there was none. */
  readonly value: string | undefined;
  /** The argument as it was typed. */
  readonly arg: string;
  /**
   * True when the argument is a plain value rather than a flag. Only
   * commands that accept positional arguments collect these.
   */
  readonly positional: boolean;
}

/** The arguments of one command line, in the order they were typed. */
export interface FlagValues {
  /** Every argument, in order. */
  readonly entries: readonly FlagEntry[];
  /** The arguments that are not flags, in order. */
  readonly positionals: readonly string[];
}

/** Options for the generic flag parser. */
export interface ParseFlagsOptions {
  /**
   * When true, arguments that are not flags become positionals instead
   * of unknown flags. Commands without positional arguments leave this
   * off, so a stray word is reported as an unknown option.
   */
  readonly allowPositionals?: boolean;
  /**
   * The prefix that marks an argument as a flag (default '-'). Commands
   * that only know long options pass '--'.
   */
  readonly flagPrefix?: string;
}

/**
 * Parse a command line against a set of flags.
 *
 * The parser never throws: it reports what it saw, in order, so a
 * command can validate the arguments in the order the user typed them.
 * That keeps the wording of a usage error independent of the order the
 * flags are declared in.
 */
export function parseFlags(
  argv: readonly string[],
  specs: readonly FlagSpec[],
  options: ParseFlagsOptions = {}
): FlagValues {
  const flagPrefix = options.flagPrefix ?? '-';
  const allowPositionals = options.allowPositionals ?? false;
  const entries: FlagEntry[] = [];
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const spec = findSpec(specs, arg);
    if (spec === undefined) {
      const positional = allowPositionals && !arg.startsWith(flagPrefix);
      entries.push({ name: undefined, value: undefined, arg, positional });
      if (positional) positionals.push(arg);
      continue;
    }
    const value = spec.takesValue === true ? argv[++i] : undefined;
    entries.push({ name: spec.name, value, arg, positional: false });
  }
  return { entries, positionals };
}

function findSpec(specs: readonly FlagSpec[], arg: string): FlagSpec | undefined {
  for (const spec of specs) {
    if (spec.name === arg) return spec;
    if (spec.aliases !== undefined && spec.aliases.includes(arg)) return spec;
  }
  return undefined;
}

/** Whether the flag was given at least once. */
export function hasFlag(flags: FlagValues, name: string): boolean {
  return flags.entries.some(entry => entry.name === name);
}

/** The last value given for a flag; undefined when the flag was not used. */
export function flagValue(flags: FlagValues, name: string): string | undefined {
  let value: string | undefined;
  for (const entry of flags.entries) {
    if (entry.name === name) value = entry.value;
  }
  return value;
}

/** Every value given for a flag, in the order they were typed. */
export function flagValues(flags: FlagValues, name: string): readonly (string | undefined)[] {
  return flags.entries.filter(entry => entry.name === name).map(entry => entry.value);
}
