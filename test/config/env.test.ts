import { homedir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ALLOWED_HOSTS_ENV,
  BIND_HOST_ENV,
  DEFAULT_BIND_HOST,
  DEFAULT_PORT,
  getAllowedHosts,
  getBindHost,
  getDefaultPort,
  getMemhubHome,
  getTokenFromEnv,
  getWebDistOverride,
  MEMHUB_HOME_ENV,
  PORT_ENV,
  TOKEN_ENV,
  WEB_DIST_ENV,
} from '../../src/config/env.js';

describe('config/env', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('names every environment variable it owns', () => {
    expect(MEMHUB_HOME_ENV).toBe('MEMHUB_HOME');
    expect(BIND_HOST_ENV).toBe('MEMHUB_HOST');
    expect(PORT_ENV).toBe('MEMHUB_PORT');
    expect(ALLOWED_HOSTS_ENV).toBe('MEMHUB_ALLOWED_HOSTS');
    expect(TOKEN_ENV).toBe('MEMHUB_TOKEN');
    expect(WEB_DIST_ENV).toBe('MEMHUB_WEB_DIST');
  });

  it('exposes the defaults', () => {
    expect(DEFAULT_PORT).toBe(7800);
    expect(DEFAULT_BIND_HOST).toBe('127.0.0.1');
  });

  // The accessors must never snapshot the environment at import time:
  // tests (and the CLI) change process.env while the process runs.
  describe('reads the environment on every call', () => {
    it('picks up a MEMHUB_HOME change', () => {
      vi.stubEnv(MEMHUB_HOME_ENV, join('C:', 'first'));
      expect(getMemhubHome()).toBe(join('C:', 'first'));
      vi.stubEnv(MEMHUB_HOME_ENV, join('C:', 'second'));
      expect(getMemhubHome()).toBe(join('C:', 'second'));
    });

    it('picks up a MEMHUB_HOST change', () => {
      vi.stubEnv(BIND_HOST_ENV, '0.0.0.0');
      expect(getBindHost()).toBe('0.0.0.0');
      vi.stubEnv(BIND_HOST_ENV, '10.0.0.5');
      expect(getBindHost()).toBe('10.0.0.5');
    });

    it('picks up a MEMHUB_PORT change', () => {
      vi.stubEnv(PORT_ENV, '9000');
      expect(getDefaultPort()).toBe(9000);
      vi.stubEnv(PORT_ENV, '9100');
      expect(getDefaultPort()).toBe(9100);
    });

    it('picks up a MEMHUB_ALLOWED_HOSTS change', () => {
      vi.stubEnv(ALLOWED_HOSTS_ENV, 'a.example.com');
      expect(getAllowedHosts()).toEqual(['a.example.com']);
      vi.stubEnv(ALLOWED_HOSTS_ENV, 'b.example.com');
      expect(getAllowedHosts()).toEqual(['b.example.com']);
    });

    it('picks up a MEMHUB_TOKEN change', () => {
      vi.stubEnv(TOKEN_ENV, 'token-one');
      expect(getTokenFromEnv()).toBe('token-one');
      vi.stubEnv(TOKEN_ENV, 'token-two');
      expect(getTokenFromEnv()).toBe('token-two');
    });

    it('picks up a MEMHUB_WEB_DIST change', () => {
      vi.stubEnv(WEB_DIST_ENV, join('C:', 'web-one'));
      expect(getWebDistOverride()).toBe(join('C:', 'web-one'));
      vi.stubEnv(WEB_DIST_ENV, join('C:', 'web-two'));
      expect(getWebDistOverride()).toBe(join('C:', 'web-two'));
    });
  });

  describe('getMemhubHome', () => {
    it('defaults to ~/.memhub', () => {
      vi.stubEnv(MEMHUB_HOME_ENV, '');
      expect(getMemhubHome()).toBe(join(homedir(), '.memhub'));
    });

    it('ignores a whitespace-only override', () => {
      vi.stubEnv(MEMHUB_HOME_ENV, '   ');
      expect(getMemhubHome()).toBe(join(homedir(), '.memhub'));
    });
  });

  describe('getBindHost', () => {
    it('defaults to 127.0.0.1', () => {
      vi.stubEnv(BIND_HOST_ENV, '');
      expect(getBindHost()).toBe('127.0.0.1');
    });

    it('trims whitespace', () => {
      vi.stubEnv(BIND_HOST_ENV, '  10.0.0.5  ');
      expect(getBindHost()).toBe('10.0.0.5');
    });
  });

  describe('getDefaultPort', () => {
    it('defaults to 7800', () => {
      vi.stubEnv(PORT_ENV, '');
      expect(getDefaultPort()).toBe(7800);
    });

    it('throws on an invalid MEMHUB_PORT', () => {
      vi.stubEnv(PORT_ENV, 'http');
      expect(() => getDefaultPort()).toThrow(/MEMHUB_PORT/);
    });

    it('throws on a port outside the valid range', () => {
      vi.stubEnv(PORT_ENV, '70000');
      expect(() => getDefaultPort()).toThrow(/MEMHUB_PORT/);
    });
  });

  describe('getAllowedHosts', () => {
    it('returns an empty list when unset or blank', () => {
      vi.stubEnv(ALLOWED_HOSTS_ENV, '');
      expect(getAllowedHosts()).toEqual([]);
    });

    it('parses comma-separated hostnames, trimmed and lowercased', () => {
      vi.stubEnv(ALLOWED_HOSTS_ENV, 'MemHub.Example.com, localhost ,*');
      expect(getAllowedHosts()).toEqual(['memhub.example.com', 'localhost', '*']);
    });
  });

  describe('getTokenFromEnv', () => {
    it('returns null when unset or blank', () => {
      vi.stubEnv(TOKEN_ENV, '');
      expect(getTokenFromEnv()).toBeNull();
    });

    it('trims the configured token', () => {
      vi.stubEnv(TOKEN_ENV, '  secret  ');
      expect(getTokenFromEnv()).toBe('secret');
    });
  });

  describe('getWebDistOverride', () => {
    it('returns null when unset or blank', () => {
      vi.stubEnv(WEB_DIST_ENV, '');
      expect(getWebDistOverride()).toBeNull();
      vi.stubEnv(WEB_DIST_ENV, '   ');
      expect(getWebDistOverride()).toBeNull();
    });

    it('returns the raw value so the caller can resolve it', () => {
      vi.stubEnv(WEB_DIST_ENV, '  C:/web/dist  ');
      expect(getWebDistOverride()).toBe('  C:/web/dist  ');
    });
  });
});
