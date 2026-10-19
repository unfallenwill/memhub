/**
 * The daemon configuration.
 *
 * The default port comes from the environment (MEMHUB_PORT): a library
 * user that calls the daemon programmatically must get the same port as
 * the CLI. The regression test below pins that behaviour - it used to be
 * hard-coded to the constant, which silently ignored MEMHUB_PORT.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { resolveDaemonConfig } from '../../src/daemon/config.js';
import { BIND_HOST_ENV, DEFAULT_PORT, PORT_ENV } from '../../src/config/env.js';

describe('resolveDaemonConfig', () => {
  const originalPort = process.env[PORT_ENV];
  const originalHost = process.env[BIND_HOST_ENV];

  afterEach(() => {
    if (originalPort === undefined) delete process.env[PORT_ENV];
    else process.env[PORT_ENV] = originalPort;
    if (originalHost === undefined) delete process.env[BIND_HOST_ENV];
    else process.env[BIND_HOST_ENV] = originalHost;
  });

  it('falls back to the default port', () => {
    delete process.env[PORT_ENV];
    expect(resolveDaemonConfig().port).toBe(DEFAULT_PORT);
  });

  it('takes the default port from MEMHUB_PORT', () => {
    process.env[PORT_ENV] = '9123';
    expect(resolveDaemonConfig().port).toBe(9123);
  });

  it('prefers an explicit port over the environment', () => {
    process.env[PORT_ENV] = '9123';
    expect(resolveDaemonConfig({ port: 4321 }).port).toBe(4321);
  });

  it('keeps port 0 (pick a free port)', () => {
    process.env[PORT_ENV] = '9123';
    expect(resolveDaemonConfig({ port: 0 }).port).toBe(0);
  });

  it('rejects a malformed MEMHUB_PORT instead of binding the default', () => {
    process.env[PORT_ENV] = 'not-a-port';
    expect(() => resolveDaemonConfig()).toThrow(/MEMHUB_PORT/);
  });

  it('resolves the home directory', () => {
    expect(resolveDaemonConfig({ home: '/tmp/memhub-home' }).home).toBe('/tmp/memhub-home');
  });

  it('resolves the bind host from the environment', () => {
    process.env[BIND_HOST_ENV] = '0.0.0.0';
    expect(resolveDaemonConfig().host).toBe('0.0.0.0');
  });

  it('prefers an explicit bind host over the environment', () => {
    process.env[BIND_HOST_ENV] = '0.0.0.0';
    expect(resolveDaemonConfig({ host: '127.0.0.1' }).host).toBe('127.0.0.1');
  });

  it('disables the web UI when the directory is null', () => {
    expect(resolveDaemonConfig({ webDist: null }).webDist).toBeUndefined();
  });

  it('uses the given web directory', () => {
    expect(resolveDaemonConfig({ webDist: '/srv/memhub-web' }).webDist).toBe('/srv/memhub-web');
  });
});
