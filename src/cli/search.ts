/**
 * `memhub search` command.
 *
 * Searches cards via POST /api/search and prints the response as a single
 * line of JSON (easy for agents to parse). Intended for coding agents
 * (the memhub skill).
 */

import { SEARCH_MODES, type SearchMode } from '../db/types.js';
import { resolveExistingToken } from '../daemon/token.js';
import { getMemhubHome, getTokenPath } from '../paths.js';
import { parsePortValue } from './args.js';
import { postApiJson, printApiFailure, remoteApiFetch } from './client.js';
import { normalizeBaseUrl, resolveRemoteToken } from './credentials.js';

/** Options for the search command. */
export interface SearchCommandOptions {
  readonly query: string;
  readonly mode: SearchMode;
  readonly limit: number;
  readonly port: number;
  /** Remote daemon base URL (memhub login target); local when unset. */
  readonly url?: string | undefined;
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
  let portSet = false;
  let url: string | undefined;
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
      portSet = true;
    } else if (arg === '--url') {
      url = requireSearchValue('--url', argv[++i]);
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
  if (url !== undefined && normalizeBaseUrl(url) === null) {
    throw new Error(`invalid --url value: ${url}`);
  }
  if (url !== undefined && portSet) {
    throw new Error('--url and --port are mutually exclusive');
  }
  return { query, mode, limit, port, url };
}

function requireSearchValue(name: string, value: string | undefined): string {
  if (value === undefined || value === '') {
    throw new Error(`missing value for ${name}`);
  }
  return value;
}

/** Run the search command. Returns the process exit code. */
export async function runSearchCommand(options: SearchCommandOptions): Promise<number> {
  const payload = {
    query: options.query,
    mode: options.mode,
    limit: options.limit,
  };

  if (options.url !== undefined) {
    const baseUrl = normalizeBaseUrl(options.url);
    if (baseUrl === null) {
      console.error(`Invalid server URL: ${options.url}`);
      return 1;
    }
    const resolved = resolveRemoteToken(baseUrl, options.home ?? getMemhubHome());
    if ('error' in resolved) {
      console.error(`${resolved.error} — run: memhub login ${baseUrl}`);
      return 1;
    }
    const result = await remoteApiFetch(baseUrl, resolved.token, 'POST', '/api/search', payload);
    if (result.kind !== 'ok' || result.status !== 200) {
      printApiFailure(result, baseUrl);
      return 1;
    }
    console.log(JSON.stringify(result.body));
    return 0;
  }

  const token = resolveExistingToken(getTokenPath(options.home ?? getMemhubHome()));
  if (token === null) {
    console.error('No MemHub token found — start the daemon first: memhub server');
    return 1;
  }

  const result = await postApiJson(options.port, token, '/api/search', payload);
  if (result.kind !== 'ok' || result.status !== 200) {
    printApiFailure(result, `http://127.0.0.1:${options.port}`);
    return 1;
  }
  console.log(JSON.stringify(result.body));
  return 0;
}
