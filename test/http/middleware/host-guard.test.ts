import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createHostGuard, isAllowedHost } from '../../../src/http/middleware/host-guard.js';
import { ApiError } from '../../../src/http/errors.js';

/** Loopback env: the Host check fails closed without socket info. */
const LOCAL_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
/** A remote peer: the local defaults are not allowed. */
const REMOTE_ENV = { incoming: { socket: { remoteAddress: '10.0.0.7' } } };

describe('isAllowedHost', () => {
  it('accepts every host when a wildcard is configured', () => {
    expect(isAllowedHost('anything.example.com', ['*'], false)).toBe(true);
    expect(isAllowedHost('anything.example.com', ['*'], true)).toBe(true);
  });

  it('accepts localhost from a local connection', () => {
    expect(isAllowedHost('localhost', [], true)).toBe(true);
    expect(isAllowedHost('localhost:7800', [], true)).toBe(true);
  });

  it('accepts 127.0.0.1 from a local connection', () => {
    expect(isAllowedHost('127.0.0.1', [], true)).toBe(true);
    expect(isAllowedHost('127.0.0.1:7800', [], true)).toBe(true);
  });

  it('accepts the IPv6 loopback from a local connection', () => {
    expect(isAllowedHost('[::1]', [], true)).toBe(true);
    expect(isAllowedHost('[::1]:7800', [], true)).toBe(true);
  });

  it('rejects the local defaults from a remote connection', () => {
    expect(isAllowedHost('localhost', [], false)).toBe(false);
    expect(isAllowedHost('127.0.0.1:7800', [], false)).toBe(false);
    expect(isAllowedHost('[::1]:7800', [], false)).toBe(false);
  });

  it('rejects a host that merely starts with localhost', () => {
    expect(isAllowedHost('localhost.evil.com', [], true)).toBe(false);
    expect(isAllowedHost('127.0.0.1.evil.com', [], true)).toBe(false);
  });

  it('matches a configured host with and without a port', () => {
    expect(isAllowedHost('memhub.example.com', ['memhub.example.com'], false)).toBe(true);
    expect(isAllowedHost('memhub.example.com:443', ['memhub.example.com'], false)).toBe(true);
  });

  it('rejects a host that is not configured', () => {
    expect(isAllowedHost('evil.example.com', ['memhub.example.com'], false)).toBe(false);
  });

  it('matches a configured host case-insensitively', () => {
    expect(isAllowedHost('MEMHUB.example.com', ['memhub.example.com'], false)).toBe(true);
    expect(isAllowedHost('memhub.EXAMPLE.com', ['MEMHUB.EXAMPLE.COM'], false)).toBe(true);
  });

  it('matches a configured IPv6 literal', () => {
    expect(isAllowedHost('[2001:db8::1]', ['[2001:db8::1]'], false)).toBe(true);
    expect(isAllowedHost('[2001:db8::1]:7800', ['[2001:db8::1]'], false)).toBe(true);
  });

  it('rejects a malformed IPv6 literal', () => {
    expect(isAllowedHost('[::1', [], true)).toBe(false);
    expect(isAllowedHost('[::1', ['[::1]'], true)).toBe(false);
  });

  it('rejects an empty host', () => {
    expect(isAllowedHost('', [], true)).toBe(false);
  });
});

describe('createHostGuard', () => {
  /** A tiny app with the guard and one route behind it. */
  function app(allowedHosts: readonly string[]): Hono {
    const instance = new Hono();
    instance.onError((error, c) =>
      error instanceof ApiError
        ? c.json({ error: error.code }, error.status as 400)
        : c.text('boom', 500)
    );
    instance.use('*', createHostGuard(allowedHosts));
    instance.get('/', c => c.text('ok'));
    return instance;
  }

  it('lets a local request through', async () => {
    const response = await app([]).request('/', { headers: { host: '127.0.0.1:7800' } }, LOCAL_ENV);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });

  it('rejects a request without a Host header', async () => {
    const response = await app([]).request('/', {}, LOCAL_ENV);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'invalid_host' });
  });

  it('rejects a remote request with a local Host header', async () => {
    const response = await app([]).request(
      '/',
      { headers: { host: '127.0.0.1:7800' } },
      REMOTE_ENV
    );

    expect(response.status).toBe(403);
  });

  it('lets a configured host through from a remote peer', async () => {
    const response = await app(['memhub.example.com']).request(
      '/',
      { headers: { host: 'memhub.example.com' } },
      REMOTE_ENV
    );

    expect(response.status).toBe(200);
  });

  it('lets every host through when a wildcard is configured', async () => {
    const response = await app(['*']).request(
      '/',
      { headers: { host: 'evil.example.com' } },
      REMOTE_ENV
    );

    expect(response.status).toBe(200);
  });
});
