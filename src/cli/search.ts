/**
 * `memhub search` command.
 *
 * Searches cards via POST /api/search and prints the response as a single
 * line of JSON (easy for agents to parse). Intended for coding agents
 * (the memhub skill).
 */

import { SEARCH_MODES, type SearchMode } from '../db/types.js';
import { getDefaultPort, getMemhubHome } from '../paths.js';
import { parsePortValue } from './args.js';
import { connectHost, postApiJson, printApiFailure, remoteApiFetch } from './client.js';
import { normalizeBaseUrl } from './credentials.js';
import { resolveCommandTarget } from './target.js';

/** Options for the search command. */
export interface SearchCommandOptions {
  readonly query: string;
  readonly mode: SearchMode;
  readonly limit: number;
  readonly port: number;
  /** Explicit remote base URL; overrides the config default, beats --port. */
  readonly url?: string | undefined;
  /** True when --port/-p was passed explicitly (forces the local daemon). */
  readonly portSet?: boolean | undefined;
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
  let port = getDefaultPort();
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
    } else if (arg === '--base-url') {
      url = requireSearchValue('--base-url', argv[++i]);
    } else if (arg === '--url') {
      throw new Error('--url was renamed to --base-url');
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
    throw new Error(`invalid --base-url value: ${url}`);
  }
  if (url !== undefined && portSet) {
    throw new Error('--base-url and --port are mutually exclusive');
  }
  return { query, mode, limit, port, portSet, url };
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

  const target = resolveCommandTarget({
    url: options.url,
    port: options.port,
    portSet: options.portSet,
    home: options.home ?? getMemhubHome(),
  });
  if (target.kind === 'error') {
    console.error(target.message);
    return 1;
  }

  const result =
    target.kind === 'remote'
      ? await remoteApiFetch(target.baseUrl, target.token, 'POST', '/api/search', payload)
      : await postApiJson(target.port, target.token, '/api/search', payload);
  if (result.kind !== 'ok' || result.status !== 200) {
    printApiFailure(
      result,
      target.kind === 'remote' ? target.baseUrl : `http://${connectHost()}:${target.port}`,
      { remote: target.kind === 'remote' }
    );
    return 1;
  }
  console.log(JSON.stringify(result.body));
  return 0;
}
