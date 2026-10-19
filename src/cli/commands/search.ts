/**
 * `memhub search` command.
 *
 * Searches cards via POST /api/search and prints the response as a single
 * line of JSON (easy for agents to parse). Intended for coding agents
 * (the memhub skill).
 */

import { SEARCH_MODES, type SearchMode } from '../../db/types.js';
import { getDefaultPort, getMemhubHome } from '../../paths.js';
import { normalizeBaseUrl } from '../credentials.js';
import { createClient, type DaemonClient } from '../http/client.js';
import { printApiFailure } from '../http/render.js';
import { parseFlags, parsePortValue, requireValue, PORT_FLAG, type FlagSpec } from '../options.js';
import type { CommandImplementation } from '../types.js';
import { resolveCommandTarget } from '../target.js';

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
  /** Daemon override (tests); defaults to the resolved target. */
  readonly client?: DaemonClient | undefined;
}

/** The flags `memhub search` understands. */
const SEARCH_FLAGS: readonly FlagSpec[] = [
  { name: '--mode', takesValue: true },
  { name: '--limit', takesValue: true },
  PORT_FLAG,
  { name: '--base-url', takesValue: true },
  { name: '--url' },
];

function isSearchMode(value: string | undefined): value is SearchMode {
  return value !== undefined && (SEARCH_MODES as readonly string[]).includes(value);
}

/** Parse `memhub search` arguments. Throws on invalid input. */
export function parseSearchArgs(argv: readonly string[]): SearchCommandOptions {
  const flags = parseFlags(argv, SEARCH_FLAGS, { allowPositionals: true, flagPrefix: '--' });
  let query: string | undefined;
  let mode: SearchMode = 'auto';
  let limit = 10;
  let port = getDefaultPort();
  let portSet = false;
  let url: string | undefined;
  for (const entry of flags.entries) {
    if (entry.positional) {
      if (query === undefined) {
        query = entry.arg;
      } else {
        throw new Error(`unexpected argument: ${entry.arg}`);
      }
      continue;
    }
    switch (entry.name) {
      case '--mode': {
        const value = entry.value;
        if (!isSearchMode(value)) {
          throw new Error(
            `invalid --mode value: ${value ?? '(missing)'} (expected one of ${SEARCH_MODES.join(', ')})`
          );
        }
        mode = value;
        break;
      }
      case '--limit': {
        const value = entry.value;
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
          throw new Error(`invalid --limit value: ${value ?? '(missing)'} (1-100)`);
        }
        limit = parsed;
        break;
      }
      case '--port':
        port = parsePortValue(entry.value);
        portSet = true;
        break;
      case '--base-url':
        url = requireValue('--base-url', entry.value);
        break;
      case '--url':
        throw new Error('--url was renamed to --base-url');
      default:
        throw new Error(`unknown option for search: ${entry.arg}`);
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

/** Run the search command. Returns the process exit code. */
export async function runSearchCommand(options: SearchCommandOptions): Promise<number> {
  const payload = {
    query: options.query,
    mode: options.mode,
    limit: options.limit,
  };

  const client = options.client ?? resolveClient(options);
  if (client === undefined) {
    return 1;
  }
  const result = await client.post('/api/search', payload);
  if (result.kind !== 'ok' || result.status !== 200) {
    printApiFailure(result, client.target, { remote: client.remote });
    return 1;
  }
  console.log(JSON.stringify(result.body));
  return 0;
}

/** Resolve the daemon to search; undefined when the target is invalid. */
function resolveClient(options: SearchCommandOptions): DaemonClient | undefined {
  const target = resolveCommandTarget({
    url: options.url,
    port: options.port,
    portSet: options.portSet,
    home: options.home ?? getMemhubHome(),
  });
  if (target.kind === 'error') {
    console.error(target.message);
    return undefined;
  }
  return createClient(target);
}

/** The search command, as the registry sees it. */
export const searchCommand: CommandImplementation<SearchCommandOptions> = {
  parse: parseSearchArgs,
  run: runSearchCommand,
};
