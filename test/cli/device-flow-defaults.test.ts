/**
 * The device flow state machine (src/cli/device-flow.ts).
 *
 * The state machine is pure: it takes the clock and the sleep function
 * as parameters. This file covers the defaults it falls back to when
 * they are not injected - the real sleep and the real clock - and the
 * terminal states of the machine.
 */

import { describe, expect, it, vi } from 'vitest';
import { runDeviceFlow } from '../../src/cli/device-flow.js';

const GRANT = {
  device_code: 'd'.repeat(64),
  user_code: 'ABCD-1234',
  verification_uri: 'https://x.example/login',
  verification_uri_complete: 'https://x.example/login?code=ABCD-1234',
  expires_in: 300,
  interval: 0,
  requires_setup: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A fetch that answers the code request and then the token poll. */
function flowFetch(tokenBody: unknown, tokenStatus = 200): typeof fetch {
  return vi.fn(async (input: string) => {
    const url = String(input);
    if (url.endsWith('/oauth/device/code')) return jsonResponse(GRANT);
    return jsonResponse(tokenBody, tokenStatus);
  }) as unknown as typeof fetch;
}

describe('runDeviceFlow', () => {
  it('uses the default sleep and clock when none are injected', async () => {
    const fetchImpl = flowFetch({ access_token: 't'.repeat(64), token_type: 'Bearer' });

    const outcome = await runDeviceFlow({
      baseUrl: 'https://x.example',
      label: 'cli',
      fetchImpl,
    });

    expect(outcome).toEqual({ kind: 'granted', accessToken: 't'.repeat(64) });
  });

  it('hands the grant to the callback before the first poll', async () => {
    const fetchImpl = flowFetch({ access_token: 't'.repeat(64), token_type: 'Bearer' });
    const onGrant = vi.fn();

    await runDeviceFlow({
      baseUrl: 'https://x.example',
      label: 'cli',
      fetchImpl,
      onGrant,
    });

    expect(onGrant).toHaveBeenCalledTimes(1);
    expect(onGrant.mock.calls[0][0]).toMatchObject({ user_code: 'ABCD-1234' });
  });

  it('refuses a code request that is not accepted', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'invalid_client' }, 403));

    const outcome = await runDeviceFlow({
      baseUrl: 'https://x.example',
      label: 'cli',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(outcome).toEqual({ kind: 'refused', status: 403 });
  });

  it('reports a denied authorization', async () => {
    const outcome = await runDeviceFlow({
      baseUrl: 'https://x.example',
      label: 'cli',
      fetchImpl: flowFetch({ error: 'access_denied' }, 400),
    });

    expect(outcome).toEqual({ kind: 'denied' });
  });

  it('reports an expired code', async () => {
    const outcome = await runDeviceFlow({
      baseUrl: 'https://x.example',
      label: 'cli',
      fetchImpl: flowFetch({ error: 'expired_token' }, 400),
    });

    expect(outcome).toEqual({ kind: 'expired' });
  });

  it('reports a rejected poll with its status', async () => {
    const outcome = await runDeviceFlow({
      baseUrl: 'https://x.example',
      label: 'cli',
      fetchImpl: flowFetch({ error: 'invalid_grant' }, 400),
    });

    expect(outcome).toEqual({ kind: 'rejected', status: 400 });
  });

  it('reports a poll whose body is not JSON as a rejection', async () => {
    const fetchImpl = vi.fn(async (input: string) => {
      const url = String(input);
      if (url.endsWith('/oauth/device/code')) return jsonResponse(GRANT);
      return new Response('not json', { status: 502 });
    });

    const outcome = await runDeviceFlow({
      baseUrl: 'https://x.example',
      label: 'cli',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(outcome).toEqual({ kind: 'rejected', status: 502 });
  });

  it('gives up when the deadline passed', async () => {
    let tick = 0;
    const now = (): number => {
      tick += 1_000_000;
      return tick;
    };

    const outcome = await runDeviceFlow({
      baseUrl: 'https://x.example',
      label: 'cli',
      fetchImpl: flowFetch({ error: 'authorization_pending' }, 400),
      sleep: async () => {},
      now,
    });

    expect(outcome).toEqual({ kind: 'timeout' });
  });
});
