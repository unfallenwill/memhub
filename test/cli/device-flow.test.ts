import { describe, expect, it, vi } from 'vitest';
import { runDeviceFlow, type DeviceGrant } from '../../src/cli/device-flow.js';

const GRANT: DeviceGrant = {
  device_code: 'd'.repeat(64),
  user_code: 'ABCD-1234',
  verification_uri_complete: 'https://x.example/login?code=ABCD-1234',
  expires_in: 300,
  interval: 5,
  requires_setup: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A fetch that answers the code request and then replays the polls. */
function flowFetch(polls: readonly Response[]): typeof fetch {
  let index = 0;
  return (async (input: string) => {
    const url = String(input);
    if (url.endsWith('/oauth/device/code')) return jsonResponse(GRANT);
    if (url.endsWith('/oauth/device/token')) {
      const response = polls[index] ?? polls[polls.length - 1];
      index += 1;
      if (response === undefined) throw new Error('no poll left');
      return response.clone();
    }
    throw new Error(`unexpected url: ${url}`);
  }) as unknown as typeof fetch;
}

describe('runDeviceFlow', () => {
  it('returns the access token when the user approves', async () => {
    const outcome = await runDeviceFlow({
      baseUrl: 'https://x.example',
      label: 'user@host',
      fetchImpl: flowFetch([jsonResponse({ access_token: 't'.repeat(64) })]),
      sleep: async () => {},
    });
    expect(outcome).toEqual({ kind: 'granted', accessToken: 't'.repeat(64) });
  });

  it('keeps polling while the authorization is pending', async () => {
    const outcome = await runDeviceFlow({
      baseUrl: 'https://x.example',
      label: 'user@host',
      fetchImpl: flowFetch([
        jsonResponse({ error: 'authorization_pending' }, 400),
        jsonResponse({ access_token: 'token' }),
      ]),
      sleep: async () => {},
    });
    expect(outcome).toEqual({ kind: 'granted', accessToken: 'token' });
  });

  it('slows down when the daemon asks for it', async () => {
    const intervals: number[] = [];
    const outcome = await runDeviceFlow({
      baseUrl: 'https://x.example',
      label: 'user@host',
      fetchImpl: flowFetch([
        jsonResponse({ error: 'slow_down' }, 400),
        jsonResponse({ error: 'slow_down' }, 400),
        jsonResponse({ error: 'expired_token' }, 400),
      ]),
      sleep: async ms => {
        intervals.push(ms);
      },
    });
    expect(outcome).toEqual({ kind: 'expired' });
    expect(intervals).toEqual([5000, 10000, 15000]);
  });

  it('reports an expired code', async () => {
    const outcome = await runDeviceFlow({
      baseUrl: 'https://x.example',
      label: 'user@host',
      fetchImpl: flowFetch([jsonResponse({ error: 'expired_token' }, 400)]),
      sleep: async () => {},
    });
    expect(outcome).toEqual({ kind: 'expired' });
  });

  it('reports a denied login', async () => {
    const outcome = await runDeviceFlow({
      baseUrl: 'https://x.example',
      label: 'user@host',
      fetchImpl: flowFetch([jsonResponse({ error: 'access_denied' }, 400)]),
      sleep: async () => {},
    });
    expect(outcome).toEqual({ kind: 'denied' });
  });

  it('reports a rejected token request', async () => {
    const outcome = await runDeviceFlow({
      baseUrl: 'https://x.example',
      label: 'user@host',
      fetchImpl: flowFetch([jsonResponse({ error: 'server_error' }, 500)]),
      sleep: async () => {},
    });
    expect(outcome).toEqual({ kind: 'rejected', status: 500 });
  });

  it('reports a refused code request', async () => {
    const outcome = await runDeviceFlow({
      baseUrl: 'https://x.example',
      label: 'user@host',
      fetchImpl: (async () => jsonResponse({ error: 'nope' }, 403)) as unknown as typeof fetch,
      sleep: async () => {},
    });
    expect(outcome).toEqual({ kind: 'refused', status: 403 });
  });

  it('gives up when the code expires', async () => {
    let now = 1_000_000;
    const outcome = await runDeviceFlow({
      baseUrl: 'https://x.example',
      label: 'user@host',
      fetchImpl: flowFetch([jsonResponse({ error: 'authorization_pending' }, 400)]),
      sleep: async () => {
        now += 1000;
      },
      now: () => now,
    });
    expect(outcome).toEqual({ kind: 'timeout' });
  });

  it('hands the grant to the caller before it polls', async () => {
    const onGrant = vi.fn();
    await runDeviceFlow({
      baseUrl: 'https://x.example',
      label: 'user@host',
      fetchImpl: flowFetch([jsonResponse({ access_token: 'token' })]),
      onGrant,
      sleep: async () => {},
    });
    expect(onGrant).toHaveBeenCalledWith(GRANT);
  });

  it('sends the device label with the code request', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(GRANT));
    await runDeviceFlow({
      baseUrl: 'https://x.example',
      label: 'user@host',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      client_id: 'memhub-cli',
      base_url: 'https://x.example',
      label: 'user@host',
    });
  });
});
