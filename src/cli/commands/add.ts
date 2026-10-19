/**
 * `memhub add` command.
 *
 * Writes one memory card via POST /api/cards. Intended for coding agents
 * (the memhub skill): the CLI reads the token from ~/.memhub/token so it
 * never appears in the agent's command line. Long bodies are read from
 * stdin when --body is omitted.
 */

import { CARD_TYPES, type CardType } from '../../db/types.js';
import { getDefaultPort, getMemhubHome } from '../../paths.js';
import { normalizeBaseUrl } from '../credentials.js';
import { createClient, type DaemonClient } from '../http/client.js';
import { printApiFailure } from '../http/render.js';
import { parseFlags, parsePortValue, requireValue, PORT_FLAG, type FlagSpec } from '../options.js';
import type { CommandImplementation } from '../types.js';
import { resolveCommandTarget } from '../target.js';

/** Options for the add command. */
export interface AddCommandOptions {
  readonly title: string;
  /** Card body; null means "read from stdin". */
  readonly body: string | null;
  readonly type: CardType;
  readonly cues: readonly string[];
  readonly writer: string | undefined;
  readonly port: number;
  /** Explicit remote base URL; overrides the config default, beats --port. */
  readonly url?: string | undefined;
  /** True when --port/-p was passed explicitly (forces the local daemon). */
  readonly portSet?: boolean | undefined;
  /** Data directory override (tests). */
  readonly home?: string | undefined;
  /** Stdin reader override (tests); defaults to draining process.stdin. */
  readonly readStdin?: (() => Promise<string>) | undefined;
  /** Daemon override (tests); defaults to the resolved target. */
  readonly client?: DaemonClient | undefined;
}

/** The flags `memhub add` understands. */
const ADD_FLAGS: readonly FlagSpec[] = [
  { name: '--title', takesValue: true },
  { name: '--body', takesValue: true },
  { name: '--type', takesValue: true },
  { name: '--cues', takesValue: true },
  { name: '--writer', takesValue: true },
  PORT_FLAG,
  { name: '--base-url', takesValue: true },
  { name: '--url' },
];

function isCardType(value: string | undefined): value is CardType {
  return value !== undefined && (CARD_TYPES as readonly string[]).includes(value);
}

/** Parse `memhub add` arguments. Throws on invalid input. */
export function parseAddArgs(argv: readonly string[]): AddCommandOptions {
  const flags = parseFlags(argv, ADD_FLAGS);
  let title: string | undefined;
  let body: string | null = null;
  let type: CardType = 'insight';
  const cues: string[] = [];
  let writer: string | undefined;
  let port = getDefaultPort();
  let portSet = false;
  let url: string | undefined;
  for (const entry of flags.entries) {
    switch (entry.name) {
      case '--title':
        title = requireValue('--title', entry.value);
        break;
      case '--body':
        body = requireValue('--body', entry.value);
        break;
      case '--type': {
        const value = entry.value;
        if (!isCardType(value)) {
          throw new Error(
            `invalid --type value: ${value ?? '(missing)'} (expected one of ${CARD_TYPES.join(', ')})`
          );
        }
        type = value;
        break;
      }
      case '--cues':
        cues.push(requireValue('--cues', entry.value));
        break;
      case '--writer':
        writer = requireValue('--writer', entry.value);
        break;
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
        throw new Error(`unknown option for add: ${entry.arg}`);
    }
  }
  if (title === undefined) {
    throw new Error('--title is required');
  }
  if (url !== undefined && normalizeBaseUrl(url) === null) {
    throw new Error(`invalid --base-url value: ${url}`);
  }
  if (url !== undefined && portSet) {
    throw new Error('--base-url and --port are mutually exclusive');
  }
  return { title, body, type, cues, writer, port, portSet, url };
}

/** Run the add command. Returns the process exit code. */
export async function runAddCommand(options: AddCommandOptions): Promise<number> {
  let body = options.body;
  if (body === null) {
    if (process.stdin.isTTY === true) {
      console.error(
        'No --body given and stdin is a terminal. Pass --body "<text>" or pipe the text in.'
      );
      return 1;
    }
    body = await (options.readStdin ?? readStdinAll)();
  }
  if (body.trim() === '') {
    console.error('The card body is empty.');
    return 1;
  }

  const payload: Record<string, unknown> = {
    title: options.title,
    body,
    type: options.type,
    cues: options.cues,
  };
  if (options.writer !== undefined) {
    payload.writer = options.writer;
  }

  const client = options.client ?? resolveClient(options);
  if (client === undefined) {
    return 1;
  }
  const result = await client.post('/api/cards', payload);
  if (result.kind !== 'ok' || result.status !== 202) {
    printApiFailure(result, client.target, { remote: client.remote });
    return 1;
  }
  console.log(JSON.stringify(result.body));
  return 0;
}

/** Resolve the daemon to write to; undefined when the target is invalid. */
function resolveClient(options: AddCommandOptions): DaemonClient | undefined {
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

/** Drain stdin to a string (bodies can be long markdown with any content). */
function readStdinAll(): Promise<string> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

/** The add command, as the registry sees it. */
export const addCommand: CommandImplementation<AddCommandOptions> = {
  parse: parseAddArgs,
  run: runAddCommand,
};
