/**
 * The CLI's view of a daemon (src/cli/http/client.ts).
 *
 * A command never builds a URL, a header or a token itself: it asks a
 * DaemonClient. The local and the remote client differ only in the base
 * URL and in how the failure hints read, so both share the transport.
 * These tests drive both clients through an injected fetch and assert the
 * requests that leave the process.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createClient,
  LocalDaemonClient,
  RemoteDaemonClient,
  type DaemonClient,
} from '../../../src/cli/http/client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The URL and the headers of the nth request the fetch mock received. */
function requestOf(
  fetchImpl: ReturnType<typeof vi.fn>,
  index = 0
): { url: string; init: RequestInit } {
  const call = fetchImpl.mock.calls[index] as unknown as [string, RequestInit];
  return { url: String(call[0]), init: call[1] };
}

const HEALTH = {
  app: 'memhub',
  pid: 1,
  uptime: 5,
  version: '1.0.0',
  cards: { total: 0, active: 0, pending_index: 0 },
  queue: { pending_events: 0, oldest_unindexed_age_s: 0 },
  index: { ready: false, model: null },
};

describe('RemoteDaemonClient', () => {
  it('names the daemon by its base URL', () => {
    const client = new RemoteDaemonClient('https://memhub.example.com', 'token');
    expect(client.target).toBe('https://memhub.example.com');
    expect(client.remote).toBe(true);
  });

  it('probes /healthz on the base URL', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(HEALTH));
    const client = new RemoteDaemonClient(
      'https://memhub.example.com',
      'token',
      fetchImpl as unknown as typeof fetch
    );

    const probe = await client.health();

    expect(probe.kind).toBe('memhub');
    expect(requestOf(fetchImpl).url).toBe('https://memhub.example.com/healthz');
  });

  it('posts JSON to an /api route with the device token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const client = new RemoteDaemonClient(
      'https://memhub.example.com',
      'device-token',
      fetchImpl as unknown as typeof fetch
    );

    const result = await client.post('/api/cards', { title: 't' });

    expect(result.kind).toBe('ok');
    const { url, init } = requestOf(fetchImpl);
    expect(url).toBe('https://memhub.example.com/api/cards');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-memhub-token']).toBe('device-token');
    expect(headers['content-type']).toBe('application/json');
  });

  it('asks the daemon to shut down and reports success', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const client = new RemoteDaemonClient(
      'https://memhub.example.com',
      'device-token',
      fetchImpl as unknown as typeof fetch
    );

    const accepted = await client.shutdown();

    expect(accepted).toBe(true);
    const { url, init } = requestOf(fetchImpl);
    expect(url).toBe('https://memhub.example.com/api/shutdown');
    expect(init.method).toBe('POST');
  });

  it('reports a refused shutdown', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'nope' }, 500));
    const client = new RemoteDaemonClient(
      'https://memhub.example.com',
      'device-token',
      fetchImpl as unknown as typeof fetch
    );

    expect(await client.shutdown()).toBe(false);
  });

  it('reports an unreachable daemon as a refused shutdown', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const client = new RemoteDaemonClient(
      'https://memhub.example.com',
      'device-token',
      fetchImpl as unknown as typeof fetch
    );

    expect(await client.shutdown()).toBe(false);
  });
});

describe('LocalDaemonClient', () => {
  it('names the daemon by host and port', () => {
    const client = new LocalDaemonClient(7800, 'token');
    expect(client.target).toBe('http://127.0.0.1:7800');
    expect(client.remote).toBe(false);
  });

  it('probes /healthz on the local port', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(HEALTH));
    const client = new LocalDaemonClient(7800, 'token', fetchImpl as unknown as typeof fetch);

    expect((await client.health()).kind).toBe('memhub');
    expect(requestOf(fetchImpl).url).toBe('http://127.0.0.1:7800/healthz');
  });

  it('posts JSON to the local daemon with the daemon token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }, 202));
    const client = new LocalDaemonClient(
      7800,
      'daemon-token',
      fetchImpl as unknown as typeof fetch
    );

    const result = await client.post('/api/cards', { title: 't' });

    expect(result.kind).toBe('ok');
    const { url, init } = requestOf(fetchImpl);
    expect(url).toBe('http://127.0.0.1:7800/api/cards');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-memhub-token']).toBe('daemon-token');
  });

  it('asks the local daemon to shut down', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const client = new LocalDaemonClient(
      7800,
      'daemon-token',
      fetchImpl as unknown as typeof fetch
    );

    expect(await client.shutdown()).toBe(true);
    expect(requestOf(fetchImpl).url).toBe('http://127.0.0.1:7800/api/shutdown');
  });
});

describe('createClient', () => {
  it('builds a remote client for a remote target', () => {
    const client = createClient({
      kind: 'remote',
      baseUrl: 'https://memhub.example.com',
      token: 'device-token',
    });
    expect(client).toBeInstanceOf(RemoteDaemonClient);
    expect(client.remote).toBe(true);
  });

  it('builds a local client for a local target', () => {
    const client = createClient({ kind: 'local', port: 7800, token: 'daemon-token' });
    expect(client).toBeInstanceOf(LocalDaemonClient);
    expect(client.remote).toBe(false);
  });

  it('passes the fetch implementation on to the client', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(HEALTH));
    const client: DaemonClient = createClient(
      { kind: 'remote', baseUrl: 'https://memhub.example.com', token: 'device-token' },
      fetchImpl as unknown as typeof fetch
    );

    await client.health();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
