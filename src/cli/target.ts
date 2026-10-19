/**
 * Shared target resolution for `memhub add` / `memhub search`.
 *
 * Decides which daemon a command talks to:
 *   1. an explicit --base-url flag,
 *   2. an explicit --port (forces the local daemon, overriding config),
 *   3. the default base-url from `memhub config`,
 *   4. the local daemon (MEMHUB_HOST / 127.0.0.1).
 *
 * A malformed configured base_url is an error, never a silent fallback to
 * local — cards would go to the wrong daemon.
 */

import { resolveExistingToken } from '../daemon/token.js';
import { getTokenPath } from '../paths.js';
import { normalizeBaseUrl, resolveRemoteToken } from './credentials.js';
import { readConfig } from './config-file.js';

/** Where a command should send its request, or why it cannot proceed. */
export type CommandTarget =
  | { readonly kind: 'remote'; readonly baseUrl: string; readonly token: string }
  | { readonly kind: 'local'; readonly port: number; readonly token: string }
  | { readonly kind: 'error'; readonly message: string };

/** Inputs from a parsed command plus the data directory. */
export interface CommandTargetOptions {
  /** Raw value of an explicit --base-url flag, when given. */
  readonly url?: string | undefined;
  /** Daemon port (explicit or default). */
  readonly port: number;
  /** True when --port/-p was passed explicitly (forces local). */
  readonly portSet?: boolean | undefined;
  /** Data directory. */
  readonly home: string;
}

function remoteTarget(baseUrl: string, home: string): CommandTarget {
  const resolved = resolveRemoteToken(baseUrl, home);
  if ('error' in resolved) {
    return {
      kind: 'error',
      message: `${resolved.error} — run: memhub login --base-url ${baseUrl}`,
    };
  }
  return { kind: 'remote', baseUrl, token: resolved.token };
}

/** Resolve the target daemon for a command (see module doc for the order). */
export function resolveCommandTarget(options: CommandTargetOptions): CommandTarget {
  if (options.url !== undefined) {
    const baseUrl = normalizeBaseUrl(options.url);
    if (baseUrl === null) {
      return { kind: 'error', message: `invalid --base-url value: ${options.url}` };
    }
    return remoteTarget(baseUrl, options.home);
  }
  if (options.portSet === true) {
    return localTarget(options.port, options.home);
  }
  const configured = readConfig(options.home).base_url;
  if (configured !== undefined) {
    const baseUrl = normalizeBaseUrl(configured);
    if (baseUrl === null) {
      return {
        kind: 'error',
        message: `invalid base-url in config — run: memhub config set base-url <url>`,
      };
    }
    return remoteTarget(baseUrl, options.home);
  }
  return localTarget(options.port, options.home);
}

function localTarget(port: number, home: string): CommandTarget {
  const token = resolveExistingToken(getTokenPath(home));
  if (token === null) {
    return {
      kind: 'error',
      message: 'No MemHub token found — start the daemon first: memhub server',
    };
  }
  return { kind: 'local', port, token };
}
