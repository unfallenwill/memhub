/**
 * `memhub add` command.
 *
 * Writes one memory card via POST /api/cards. Intended for coding agents
 * (the memhub skill): the CLI reads the token from ~/.memhub/token so it
 * never appears in the agent's command line. Long bodies are read from
 * stdin when --body is omitted.
 */

import { CARD_TYPES, type CardType } from '../db/types.js';
import { getMemhubHome } from '../paths.js';
import { parsePortValue, requireValue } from './args.js';
import { postApiJson, printApiFailure, remoteApiFetch } from './client.js';
import { normalizeBaseUrl } from './credentials.js';
import { resolveCommandTarget } from './target.js';

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
}

function isCardType(value: string | undefined): value is CardType {
  return value !== undefined && (CARD_TYPES as readonly string[]).includes(value);
}

/** Parse `memhub add` arguments. Throws on invalid input. */
export function parseAddArgs(argv: readonly string[]): AddCommandOptions {
  let title: string | undefined;
  let body: string | null = null;
  let type: CardType = 'insight';
  const cues: string[] = [];
  let writer: string | undefined;
  let port = 7800;
  let portSet = false;
  let url: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--title') {
      title = requireValue('--title', argv[++i]);
    } else if (arg === '--body') {
      body = requireValue('--body', argv[++i]);
    } else if (arg === '--type') {
      const value = argv[++i];
      if (!isCardType(value)) {
        throw new Error(
          `invalid --type value: ${value ?? '(missing)'} (expected one of ${CARD_TYPES.join(', ')})`
        );
      }
      type = value;
    } else if (arg === '--cues') {
      cues.push(requireValue('--cues', argv[++i]));
    } else if (arg === '--writer') {
      writer = requireValue('--writer', argv[++i]);
    } else if (arg === '--port' || arg === '-p') {
      port = parsePortValue(argv[++i]);
      portSet = true;
    } else if (arg === '--base-url') {
      url = requireValue('--base-url', argv[++i]);
    } else if (arg === '--url') {
      throw new Error('--url was renamed to --base-url');
    } else {
      throw new Error(`unknown option for add: ${arg}`);
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
      ? await remoteApiFetch(target.baseUrl, target.token, 'POST', '/api/cards', payload)
      : await postApiJson(target.port, target.token, '/api/cards', payload);
  if (result.kind !== 'ok' || result.status !== 202) {
    printApiFailure(
      result,
      target.kind === 'remote' ? target.baseUrl : `http://127.0.0.1:${target.port}`
    );
    return 1;
  }
  console.log(JSON.stringify(result.body));
  return 0;
}

/** Drain stdin to a string (bodies can be long markdown with any content). */
function readStdinAll(): Promise<string> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}
