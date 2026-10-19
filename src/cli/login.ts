/**
 * `memhub login <url>` command.
 *
 * Runs the OAuth 2.1 device flow against a remote daemon: requests a
 * device code, opens the browser at the verification page (or prints
 * the URL when no browser can be launched), polls until the user
 * approves, then stores the token in <home>/credentials.json.
 */

import { hostname, userInfo } from 'os';
import { getMemhubHome } from '../paths.js';
import { probeHealthzUrl, remoteApiFetch } from './client.js';
import { normalizeBaseUrl, writeCredentials } from './credentials.js';
import { openBrowser } from './open-browser.js';

/** Options for the login command. */
export interface LoginCommandOptions {
  readonly url: string;
  /** Data directory override (tests). */
  readonly home?: string | undefined;
  /** fetch override (tests). */
  readonly fetchImpl?: typeof fetch | undefined;
  /** Browser opener override (tests). */
  readonly open?: ((url: string) => boolean) | undefined;
  /** Sleep override (tests); milliseconds. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

/** Parse `memhub login` arguments. Throws on invalid input. */
export function parseLoginArgs(argv: readonly string[]): LoginCommandOptions {
  if (argv.length !== 1) {
    throw new Error('usage: memhub login <url>  (e.g. memhub login https://memhub.example.com)');
  }
  return { url: argv[0] };
}

interface DeviceCodeResponse {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri_complete: string;
  readonly expires_in: number;
  readonly interval: number;
  readonly requires_setup: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function deviceLabel(): string {
  try {
    return `${userInfo().username}@${hostname()}`.slice(0, 100);
  } catch {
    return 'cli';
  }
}

/** Run the login command. Returns the process exit code. */
export async function runLoginCommand(options: LoginCommandOptions): Promise<number> {
  const baseUrl = normalizeBaseUrl(options.url);
  if (baseUrl === null) {
    console.error(`Invalid server URL: ${options.url}`);
    console.error('Expected something like https://memhub.example.com (no path).');
    return 1;
  }
  const doSleep = options.sleep ?? sleep;
  const open = options.open ?? openBrowser;
  const doFetch = options.fetchImpl ?? fetch;

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

  const label = deviceLabel();
  const codeResponse = await doFetch(`${baseUrl}/oauth/device/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: 'memhub-cli', base_url: baseUrl, label }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!codeResponse.ok) {
    console.error(`The daemon refused the login request (HTTP ${codeResponse.status}).`);
    return 1;
  }
  const grant = (await codeResponse.json()) as DeviceCodeResponse;

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

  const deadline = Date.now() + (grant.expires_in + 10) * 1000;
  let intervalMs = grant.interval * 1000;
  let accessToken: string | null = null;
  while (Date.now() < deadline) {
    await doSleep(intervalMs);
    const poll = await doFetch(`${baseUrl}/oauth/device/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: grant.device_code,
        client_id: 'memhub-cli',
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await poll.json().catch(() => ({}))) as { error?: string; access_token?: string };
    if (poll.ok && typeof body.access_token === 'string') {
      accessToken = body.access_token;
      break;
    }
    if (body.error === 'authorization_pending') continue;
    if (body.error === 'slow_down') {
      intervalMs += 5000;
      continue;
    }
    if (body.error === 'expired_token') {
      console.error('The login code expired. Run memhub login again.');
      return 1;
    }
    if (body.error === 'access_denied') {
      console.error('The login was denied (too many wrong passwords). Run memhub login again.');
      return 1;
    }
    console.error(`The daemon rejected the token request (HTTP ${poll.status}).`);
    return 1;
  }
  if (accessToken === null) {
    console.error('Timed out waiting for authorization. Run memhub login again.');
    return 1;
  }

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

  const home = options.home ?? getMemhubHome();
  writeCredentials(home, { version: 1, url: baseUrl, token: accessToken });
  console.log('');
  console.log(`Logged in to ${baseUrl} (MemHub v${probe.info.version}).`);
  console.log(`Token saved. Use: memhub add --url ${baseUrl} ...`);
  return 0;
}
