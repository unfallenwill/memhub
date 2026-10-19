/**
 * HTTP client helpers for the CLI.
 *
 * The CLI talks to the daemon over the same HTTP API as hooks. It
 * connects to MEMHUB_HOST when set (cloud deployments), falling back
 * to 127.0.0.1 so the Host header check passes.
 *
 * Every call goes through the single transport primitive in
 * ./http/transport.js, and every call can be handed its own fetch
 * implementation - a test never has to patch the global.
 */

import { getBindHost } from '../config/env.js';
import { requestJson, type TransportResult } from './http/transport.js';

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

/** Result of an authenticated POST to an /api route of the daemon. */
export type ApiPostResult = TransportResult;

/** Host the CLI connects to: MEMHUB_HOST unless it is a wildcard bind. */
export function connectHost(): string {
  const host = getBindHost();
  if (host === '0.0.0.0' || host === '::' || host === '[::]') {
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
export async function probeHealthz(
  port: number,
  timeoutMs = 2000,
  fetchImpl?: typeof fetch
): Promise<HealthProbe> {
  return probeHealthzUrl(`${baseUrl(port)}`, timeoutMs, fetchImpl);
}

/** POST /api/shutdown with the daemon token. Returns true on success. */
export async function postShutdown(
  port: number,
  token: string,
  fetchImpl?: typeof fetch
): Promise<boolean> {
  const result = await requestJson({
    method: 'POST',
    url: `${baseUrl(port)}/api/shutdown`,
    token,
    timeoutMs: 2000,
    fetchImpl,
  });
  return result.kind === 'ok' && result.status >= 200 && result.status < 300;
}

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
  timeoutMs = 30_000,
  fetchImpl?: typeof fetch
): Promise<ApiPostResult> {
  return requestJson({
    method: 'POST',
    url: `${baseUrl(port)}${path}`,
    token,
    body: payload,
    timeoutMs,
    fetchImpl,
  });
}

/** Probe a remote daemon by base URL (memhub login flow). */
export async function probeHealthzUrl(
  baseUrl: string,
  timeoutMs = 5000,
  fetchImpl: typeof fetch = fetch
): Promise<HealthProbe> {
  let result: TransportResult;
  try {
    result = await requestJson({
      method: 'GET',
      url: `${baseUrl.replace(/\/$/, '')}/healthz`,
      timeoutMs,
      fetchImpl,
    });
  } catch {
    // The body could not be read: something answered, but it is not a
    // MemHub daemon.
    return { kind: 'other' };
  }
  if (result.kind === 'unreachable') {
    return { kind: 'unreachable' };
  }
  if (result.status < 200 || result.status >= 300) {
    return { kind: 'other' };
  }
  const body = result.body;
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
  return requestJson({
    method,
    url: `${baseUrl.replace(/\/$/, '')}${path}`,
    token,
    body: payload,
    timeoutMs,
    contentType: 'application/json',
    fetchImpl,
  });
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
