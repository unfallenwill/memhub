#!/usr/bin/env node
/**
 * MemHub CLI entry point.
 *
 * The command table lives in ./registry.js and the help text is
 * generated from it. The commands themselves are loaded on demand, so
 * a command that only writes one card never pulls in the Hono
 * application, the database layer or the embedding stack.
 *
 * Importing this module has no side effect: it only runs the CLI when
 * it is the process entry point. The check resolves both paths to their
 * real form, so a symlinked install (npm bin-links) is recognized too -
 * see ./entry.js.
 */

import { errorMessage } from '../core/util/errors.js';
import { isEntryPoint } from './entry.js';
import { dispatch } from './registry.js';

/**
 * Run the CLI with the given arguments (without the node executable and
 * the script path). Returns the process exit code.
 */
export async function run(argv: readonly string[]): Promise<number> {
  try {
    return await dispatch(argv);
  } catch (error) {
    console.error(`Error: ${errorMessage(error)}`);
    return 1;
  }
}

/**
 * True when this module is the process the CLI was started from.
 *
 * Both paths are resolved to their real form, so a symlinked install
 * (npm bin-links) is recognized as the entry point.
 */
export function isCliEntryPoint(entry: string | undefined = process.argv[1]): boolean {
  return isEntryPoint(entry, import.meta.url);
}

if (isCliEntryPoint()) {
  run(process.argv.slice(2))
    .then(code => {
      process.exitCode = code;
    })
    .catch(error => {
      console.error(`Error: ${errorMessage(error)}`);
      process.exitCode = 1;
    });
}
