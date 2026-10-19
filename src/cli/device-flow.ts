/**
 * The OAuth 2.1 device authorization flow (RFC 8628).
 *
 * The state machine is pure: it never prints, it takes the clock and
 * the sleep function as parameters and it reports what happened as a
 * value. The login command renders that value.
 */

import { sleep } from '../core/util/sleep.js';

/** The device authorization grant the daemon hands out. */
export interface DeviceGrant {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri_complete: string;
  readonly expires_in: number;
  readonly interval: number;
  readonly requires_setup: boolean;
}

/** How the device flow ended. */
export type DeviceFlowOutcome =
  | { readonly kind: 'granted'; readonly accessToken: string }
  | { readonly kind: 'expired' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'rejected'; readonly status: number }
  | { readonly kind: 'refused'; readonly status: number };

/** Inputs of the device flow. */
export interface DeviceFlowOptions {
  /** The base URL of the daemon. */
  readonly baseUrl: string;
  /** The device label sent along with the code request. */
  readonly label: string;
  /** The fetch implementation to use. */
  readonly fetchImpl: typeof fetch;
  /** Called with the grant before the first poll. */
  readonly onGrant?: ((grant: DeviceGrant) => void) | undefined;
  /** Sleep override; milliseconds. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Clock override; milliseconds since the epoch. */
  readonly now?: (() => number) | undefined;
  /** How long one request may take. */
  readonly requestTimeoutMs?: number | undefined;
}

/** How long the flow waits before it gives up. */
const EXPIRY_SLACK_SECONDS = 10;
/** How much slower the polling gets after a "slow_down". */
const SLOW_DOWN_STEP_MS = 5000;

/**
 * Request a device code, then poll until the user approves, denies or
 * the code expires.
 */
export async function runDeviceFlow(options: DeviceFlowOptions): Promise<DeviceFlowOutcome> {
  const doSleep = options.sleep ?? sleep;
  const now = options.now ?? Date.now;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;

  const codeResponse = await options.fetchImpl(`${options.baseUrl}/oauth/device/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: 'memhub-cli',
      base_url: options.baseUrl,
      label: options.label,
    }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!codeResponse.ok) {
    return { kind: 'refused', status: codeResponse.status };
  }
  const grant = (await codeResponse.json()) as DeviceGrant;
  options.onGrant?.(grant);

  const deadline = now() + (grant.expires_in + EXPIRY_SLACK_SECONDS) * 1000;
  let intervalMs = grant.interval * 1000;
  while (now() < deadline) {
    await doSleep(intervalMs);
    const poll = await options.fetchImpl(`${options.baseUrl}/oauth/device/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: grant.device_code,
        client_id: 'memhub-cli',
      }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const body = (await poll.json().catch(() => ({}))) as {
      error?: string;
      access_token?: string;
    };
    if (poll.ok && typeof body.access_token === 'string') {
      return { kind: 'granted', accessToken: body.access_token };
    }
    if (body.error === 'authorization_pending') continue;
    if (body.error === 'slow_down') {
      intervalMs += SLOW_DOWN_STEP_MS;
      continue;
    }
    if (body.error === 'expired_token') return { kind: 'expired' };
    if (body.error === 'access_denied') return { kind: 'denied' };
    return { kind: 'rejected', status: poll.status };
  }
  return { kind: 'timeout' };
}
