/**
 * `memhub login --base-url <url>` command.
 *
 * Runs the OAuth 2.1 device flow against a remote daemon: requests a
 * device code, opens the browser at the verification page (or prints
 * the URL when no browser can be launched), polls until the user
 * approves, then stores the token in <home>/credentials.json.
 * Without --base-url the configured default (memhub config) is used.
 *
 * The state machine itself lives in ../device-flow.ts: this module only
 * orchestrates and renders.
 */

import { hostname, userInfo } from 'os';
import { errorMessage } from '../../core/util/errors.js';
import { getMemhubHome } from '../../paths.js';
import { probeHealthzUrl, remoteApiFetch } from '../client.js';
import { readConfig } from '../config-file.js';
import { normalizeBaseUrl, writeCredentials } from '../credentials.js';
import { runDeviceFlow, type DeviceGrant } from '../device-flow.js';
import { openBrowser } from '../open-browser.js';
import { parseFlags, requireValue } from '../options.js';
import type { CommandImplementation } from '../types.js';

/** Options for the login command. */
export interface LoginCommandOptions {
  /** Remote daemon base URL; falls back to the config default when unset. */
  readonly url?: string | undefined;
  /** Data directory override (tests). */
  readonly home?: string | undefined;
  /** fetch override (tests). */
  readonly fetchImpl?: typeof fetch | undefined;
  /** Browser opener override (tests). */
  readonly open?: ((url: string) => boolean) | undefined;
  /** Sleep override (tests); milliseconds. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Clock override (tests); milliseconds since the epoch. */
  readonly now?: (() => number) | undefined;
}

/** Parse `memhub login` arguments. Throws on invalid input. */
export function parseLoginArgs(argv: readonly string[]): LoginCommandOptions {
  const flags = parseFlags(argv, [{ name: '--base-url', takesValue: true }]);
  let url: string | undefined;
  for (const entry of flags.entries) {
    switch (entry.name) {
      case '--base-url':
        url = requireValue('--base-url', entry.value);
        break;
      default:
        throw new Error(`unexpected argument: ${entry.arg} — use: memhub login --base-url <url>`);
    }
  }
  return { url };
}

function deviceLabel(): string {
  try {
    return `${userInfo().username}@${hostname()}`.slice(0, 100);
  } catch {
    return 'cli';
  }
}

/** Show the user code and open the browser at the verification page. */
function renderGrant(grant: DeviceGrant, open: (url: string) => boolean): void {
  if (grant.requires_setup) {
    console.log('This server has no admin password yet.');
    console.log(
      'The next step will SET the administrator password — make sure you own this server.'
    );
    console.log(
      'If the login page asks for a setup code, read it on the server: the daemon prints it ' +
        'at startup and stores it in the setup-code file inside its data directory.'
    );
  }
  console.log('');
  console.log(`Your code: ${grant.user_code}`);
  console.log(`Open:      ${grant.verification_uri_complete}`);
  const launched = open(grant.verification_uri_complete);
  if (!launched) {
    console.log('(no browser could be opened — visit the URL above manually)');
  }
  console.log('Waiting for authorization... (Ctrl+C to cancel)');
}

/** Run the login command. Returns the process exit code. */
export async function runLoginCommand(options: LoginCommandOptions): Promise<number> {
  const home = options.home ?? getMemhubHome();
  let configured: string | undefined;
  try {
    configured = readConfig(home).base_url;
  } catch (error) {
    console.error(errorMessage(error));
    return 1;
  }
  const rawUrl = options.url ?? configured;
  if (rawUrl === undefined) {
    console.error('usage: memhub login --base-url <url>');
    console.error('e.g. memhub login --base-url https://memhub.example.com');
    return 1;
  }
  const baseUrl = normalizeBaseUrl(rawUrl);
  if (baseUrl === null) {
    if (options.url === undefined) {
      console.error(`Invalid base-url in the config: ${rawUrl}`);
      console.error('Fix it with: memhub config set base-url <url>');
    } else {
      console.error(`Invalid server URL: ${rawUrl}`);
      console.error('Expected something like https://memhub.example.com (no path).');
    }
    return 1;
  }
  const doFetch = options.fetchImpl ?? fetch;
  const open = options.open ?? openBrowser;

  const probe = await probeHealthzUrl(baseUrl, 5000, doFetch);
  if (probe.kind !== 'memhub') {
    console.error(`Cannot reach a MemHub daemon at ${baseUrl}.`);
    if (probe.kind === 'other') {
      console.error(
        'Hint: the daemon rejected the Host header — add this hostname to MEMHUB_ALLOWED_HOSTS on the server.'
      );
    }
    return 1;
  }

  const outcome = await runDeviceFlow({
    baseUrl,
    label: deviceLabel(),
    fetchImpl: doFetch,
    onGrant: grant => renderGrant(grant, open),
    sleep: options.sleep,
    now: options.now,
  });
  if (outcome.kind !== 'granted') {
    switch (outcome.kind) {
      case 'refused':
        console.error(`The daemon refused the login request (HTTP ${outcome.status}).`);
        break;
      case 'expired':
        console.error('The login code expired. Run memhub login again.');
        break;
      case 'denied':
        console.error('The login was denied (too many wrong passwords). Run memhub login again.');
        break;
      case 'rejected':
        console.error(`The daemon rejected the token request (HTTP ${outcome.status}).`);
        break;
      case 'timeout':
        console.error('Timed out waiting for authorization. Run memhub login again.');
        break;
    }
    return 1;
  }
  const accessToken = outcome.accessToken;

  // Prove the token actually works before persisting it.
  const verify = await remoteApiFetch(
    baseUrl,
    accessToken,
    'GET',
    '/api/queue',
    undefined,
    30_000,
    doFetch
  );
  if (verify.kind !== 'ok' || verify.status !== 200) {
    console.error('The token was issued but does not work — refusing to save it.');
    return 1;
  }

  writeCredentials(home, { version: 1, url: baseUrl, token: accessToken });
  console.log('');
  console.log(`Logged in to ${baseUrl} (MemHub v${probe.info.version}).`);
  const configuredNormalized = configured === undefined ? undefined : normalizeBaseUrl(configured);
  if (configuredNormalized !== undefined && configuredNormalized !== baseUrl) {
    // Otherwise the next plain `memhub add` targets the old server and the
    // resulting hint would overwrite this fresh login.
    console.log(`Note: the configured default base-url is still ${configuredNormalized}.`);
    console.log(
      `Plain memhub add targets it — change it with: memhub config set base-url ${baseUrl}`
    );
  }
  console.log(`Token saved. Use: memhub add --base-url ${baseUrl} ...`);
  console.log(`Or make it the default: memhub config set base-url ${baseUrl}`);
  return 0;
}

/** The login command, as the registry sees it. */
export const loginCommand: CommandImplementation<LoginCommandOptions> = {
  parse: parseLoginArgs,
  run: runLoginCommand,
};
