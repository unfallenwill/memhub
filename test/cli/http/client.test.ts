import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createClient,
  LocalDaemonClient,
  RemoteDaemonClient,
} from '../../../src/cli/http/client.js';

const healthBody = {
  app: 'memhub',
  pid: 123,
  uptime: 10,
  version: '1.0.0',
  cards: { total: 1, active: 1, pending_index: 0 },
  queue: { pending_events: 0, oldest_unindexed_age_s: 0 },
  index: { ready: false, model: null },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('LocalDaemonClient', () => {
  it('describes the local daemon it talks to', () => {
    const client = new LocalDaemonClient(7800, 'token');
    expect(client.target).toBe('http://127.0.0.1:7800');
    expect(client.remote).toBe(false);
  });

  it('posts to the local daemon with the daemon token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 1 }, 202));
    const client = new LocalDaemonClient(7800, 'secret', fetchImpl);
    const result = await client.post('/api/cards', { title: 'T' });
    expect(result).toEqual({ kind: 'ok', status: 202, body: { id: 1 } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:7800/api/cards');
    expect(new Headers(init.headers).get('x-memhub-token')).toBe('secret');
  });

  it('probes the health endpoint', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(healthBody));
    const client = new LocalDaemonClient(7800, 'secret', fetchImpl);
    expect(await client.health()).toEqual({ kind: 'memhub', info: healthBody });
  });

  it('asks the daemon to shut down', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const client = new LocalDaemonClient(7800, 'secret', fetchImpl);
    expect(await client.shutdown()).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:7800/api/shutdown');
    expect(init.method).toBe('POST');
  });

  it('reports a rejected shutdown', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { code: 'unauthorized' } }, 401));
    const client = new LocalDaemonClient(7800, 'secret', fetchImpl);
    expect(await client.shutdown()).toBe(false);
  });
});

describe('RemoteDaemonClient', () => {
  it('describes the remote daemon it talks to', () => {
    const client = new RemoteDaemonClient('https://x.example', 'device-token');
    expect(client.target).toBe('https://x.example');
    expect(client.remote).toBe(true);
  });

  it('posts to the remote daemon with the device token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [] }));
    const client = new RemoteDaemonClient('https://x.example', 'device-token', fetchImpl);
    const result = await client.post('/api/search', { query: 'q' });
    expect(result.kind).toBe('ok');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://x.example/api/search');
    expect(new Headers(init.headers).get('x-memhub-token')).toBe('device-token');
  });

  it('probes the health endpoint of the remote daemon', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(healthBody));
    const client = new RemoteDaemonClient('https://x.example', 'device-token', fetchImpl);
    expect(await client.health()).toEqual({ kind: 'memhub', info: healthBody });
  });

  it('reports an unreachable remote daemon', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const client = new RemoteDaemonClient('https://x.example', 'device-token', fetchImpl);
    expect(await client.health()).toEqual({ kind: 'unreachable' });
  });
});

describe('createClient', () => {
  it('builds a local client for a local target', () => {
    const client = createClient({ kind: 'local', port: 7900, token: 'token' });
    expect(client).toBeInstanceOf(LocalDaemonClient);
    expect(client.target).toBe('http://127.0.0.1:7900');
  });

  it('builds a remote client for a remote target', () => {
    const client = createClient({ kind: 'remote', baseUrl: 'https://x.example', token: 'token' });
    expect(client).toBeInstanceOf(RemoteDaemonClient);
    expect(client.remote).toBe(true);
  });
});
