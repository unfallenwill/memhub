/**
 * Entry point detection for the CLI.
 *
 * npm installs the `memhub` bin as a symlink to
 * dist/src/cli/index.js (POSIX bin-links) and pnpm wraps it in a shell
 * script. In the symlink case `process.argv[1]` keeps the path the user
 * typed - the symlink - while `import.meta.url` always points at the
 * real file. Comparing the two raw strings therefore fails under a
 * symlinked install: the CLI would silently do nothing and exit 0.
 *
 * Both sides are resolved to their real path before they are compared,
 * so the check holds for a symlink, a junction and a plain path alike.
 */

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve a path to its real, symlink-free form.
 *
 * A path that does not exist (or cannot be read) falls back to its
 * lexical form, so both sides of a comparison stay comparable.
 */
export function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * True when `entry` is the module `moduleUrl` points at.
 *
 * `entry` is usually `process.argv[1]` and `moduleUrl` usually
 * `import.meta.url`. Both are resolved to their real path first, so a
 * symlinked install is recognized as the entry point.
 */
export function isEntryPoint(entry: string | undefined, moduleUrl: string): boolean {
  if (entry === undefined) return false;
  let modulePath: string;
  try {
    modulePath = fileURLToPath(moduleUrl);
  } catch {
    // Not a file URL: there is nothing to compare against.
    return false;
  }
  return realPath(entry) === realPath(modulePath);
}

/**
 * The real path of the CLI entry script.
 *
 * The background daemon is spawned with this path, so the child process
 * starts the very same file the parent was started from - even when the
 * parent was started through a symlink.
 *
 * Throws when the process was not started from a script.
 */
export function cliEntryPath(): string {
  const entry = process.argv[1];
  if (entry === undefined) {
    throw new Error('cannot determine CLI entry path');
  }
  return realPath(entry);
}
