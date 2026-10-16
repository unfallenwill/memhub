/**
 * Shared option parsing for CLI commands.
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
