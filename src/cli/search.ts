/**
 * `memhub search` command.
 *
 * Searches cards via POST /api/search and prints the response as a single
 * line of JSON (easy for agents to parse). Intended for coding agents
 * (the memhub skill).
 */

import { SEARCH_MODES, type SearchMode } from '../db/types.js';
import { readToken } from '../daemon/token.js';
import { getMemhubHome, getTokenPath } from '../paths.js';
import { parsePortValue } from './args.js';
import { postApiJson, printApiFailure } from './client.js';

/** Options for the search command. */
export interface SearchCommandOptions {
  readonly query: string;
  readonly mode: SearchMode;
  readonly limit: number;
  readonly port: number;
  /** Data directory override (tests). */
  readonly home?: string | undefined;
}

function isSearchMode(value: string | undefined): value is SearchMode {
  return value !== undefined && (SEARCH_MODES as readonly string[]).includes(value);
}

/** Parse `memhub search` arguments. Throws on invalid input. */
export function parseSearchArgs(argv: readonly string[]): SearchCommandOptions {
  let query: string | undefined;
  let mode: SearchMode = 'auto';
  let limit = 10;
  let port = 7800;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--mode') {
      const value = argv[++i];
      if (!isSearchMode(value)) {
        throw new Error(
          `invalid --mode value: ${value ?? '(missing)'} (expected one of ${SEARCH_MODES.join(', ')})`
        );
      }
      mode = value;
    } else if (arg === '--limit') {
      const value = argv[++i];
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
        throw new Error(`invalid --limit value: ${value ?? '(missing)'} (1-100)`);
      }
      limit = parsed;
    } else if (arg === '--port' || arg === '-p') {
      port = parsePortValue(argv[++i]);
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option for search: ${arg}`);
    } else if (query === undefined) {
      query = arg;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  if (query === undefined) {
    throw new Error('a search query is required: memhub search "<query>"');
  }
  return { query, mode, limit, port };
}

/** Run the search command. Returns the process exit code. */
export async function runSearchCommand(options: SearchCommandOptions): Promise<number> {
  const token = readToken(getTokenPath(options.home ?? getMemhubHome()));
  if (token === null) {
    console.error('No MemHub token found — start the daemon first: memhub server');
    return 1;
  }

  const result = await postApiJson(options.port, token, '/api/search', {
    query: options.query,
    mode: options.mode,
    limit: options.limit,
  });
  if (result.kind !== 'ok' || result.status !== 200) {
    printApiFailure(result, options.port);
    return 1;
  }
  console.log(JSON.stringify(result.body));
  return 0;
}
