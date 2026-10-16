/**
 * HTTP client helpers for the CLI.
 *
 * The CLI talks to the daemon over the same HTTP API as hooks. It
 * connects to MEMHUB_HOST when set (cloud deployments), falling back
 * to 127.0.0.1 so the Host header check passes.
 */

import { BIND_HOST_ENV } from '../paths.js';

/** Health payload returned by GET /healthz. */
export interface HealthInfo {
  readonly app: 'memhub';
  readonly pid: number;
  readonly uptime: number;
  readonly version: string;
  readonly cards: {
    readonly total: number;
    readonly active: number;
    readonly pending_index: number;
  };
  readonly queue: { readonly pending_events: number; readonly oldest_unindexed_age_s: number };
  readonly index: { readonly ready: boolean; readonly model: string | null };
}

/** Result of probing a port with GET /healthz. */
export type HealthProbe =
  | { readonly kind: 'memhub'; readonly info: HealthInfo }
  | { readonly kind: 'other' }
  | { readonly kind: 'unreachable' };

/** Host the CLI connects to: MEMHUB_HOST unless it is a wildcard bind. */
export function connectHost(): string {
  const host = process.env[BIND_HOST_ENV]?.trim();
  if (host === undefined || host === '' || host === '0.0.0.0' || host === '::' || host === '[::]') {
    return '127.0.0.1';
  }
  return host;
}

function baseUrl(port: number): string {
  return `http://${connectHost()}:${port}`;
}

/**
 * Probe a daemon port. Distinguishes "a MemHub daemon" from "some other
 * program" from "nothing listening".
 */
export async function probeHealthz(port: number, timeoutMs = 2000): Promise<HealthProbe> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl(port)}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { kind: 'unreachable' };
  }
  if (!response.ok) return { kind: 'other' };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: 'other' };
  }
  if (isHealthInfo(body) && body.app === 'memhub') {
    return { kind: 'memhub', info: body };
  }
  return { kind: 'other' };
}

/** POST /api/shutdown with the daemon token. Returns true on success. */
export async function postShutdown(port: number, token: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl(port)}/api/shutdown`, {
      method: 'POST',
      headers: { 'x-memhub-token': token },
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Result of an authenticated POST to an /api route of the daemon. */
export type ApiPostResult =
  | { readonly kind: 'ok'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'unreachable' };

/**
 * POST a JSON payload to an /api route with the daemon token.
 * Network failures surface as 'unreachable'; HTTP error responses are
 * returned as-is so callers can print the daemon's {error:{code,message}}.
 */
export async function postApiJson(
  port: number,
  token: string,
  path: string,
  payload: unknown,
  timeoutMs = 30_000
): Promise<ApiPostResult> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl(port)}${path}`, {
      method: 'POST',
      headers: { 'x-memhub-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { kind: 'unreachable' };
  }
  const text = await response.text();
  let body: unknown = text;
  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { kind: 'ok', status: response.status, body };
}

/** Print an API failure (one JSON line for agents, hints for humans). */
export function printApiFailure(result: ApiPostResult, target: string): void {
  if (result.kind === 'unreachable') {
    console.error(`Cannot reach the MemHub daemon at ${target} — start it with: memhub server`);
    return;
  }
  console.error(JSON.stringify(result.body));
  if (result.status === 401) {
    console.error(
      'Hint: the token in ~/.memhub/token (or MEMHUB_TOKEN) must match the running daemon.'
    );
  } else if (result.status === 403) {
    console.error(
      'Hint: the daemon rejected the Host header. Add the hostname you use to MEMHUB_ALLOWED_HOSTS, or call via http://127.0.0.1.'
    );
  }
}

/** Probe a remote daemon by base URL (memhub login flow). */
export async function probeHealthzUrl(
  baseUrl: string,
  timeoutMs = 5000,
  fetchImpl: typeof fetch = fetch
): Promise<HealthProbe> {
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { kind: 'unreachable' };
  }
  if (!response.ok) return { kind: 'other' };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: 'other' };
  }
  if (isHealthInfo(body) && body.app === 'memhub') {
    return { kind: 'memhub', info: body };
  }
  return { kind: 'other' };
}

/** Perform an authenticated JSON request against a remote daemon. */
export async function remoteApiFetch(
  baseUrl: string,
  token: string,
  method: string,
  path: string,
  payload?: unknown,
  timeoutMs = 30_000,
  fetchImpl: typeof fetch = fetch
): Promise<ApiPostResult> {
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: { 'x-memhub-token': token, 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { kind: 'unreachable' };
  }
  const text = await response.text();
  let body: unknown = text;
  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { kind: 'ok', status: response.status, body };
}

function isHealthInfo(value: unknown): value is HealthInfo {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<HealthInfo>;
  return (
    candidate.app === 'memhub' &&
    typeof candidate.pid === 'number' &&
    typeof candidate.uptime === 'number' &&
    typeof candidate.version === 'string'
  );
}
