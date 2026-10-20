import { homedir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ALLOWED_HOSTS_ENV,
  BIND_HOST_ENV,
  DEFAULT_PORT,
  getAllowedHosts,
  getBindHost,
  getConfigPath,
  getCredentialsPath,
  getDatabasePath,
  getDefaultPort,
  getLanceDbPath,
  getLogsDir,
  getMemhubHome,
  getModelsDir,
  getSetupCodePath,
  getTokenPath,
  MEMHUB_HOME_ENV,
  PORT_ENV,
} from '../../src/config/paths.js';

describe('paths', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to ~/.memhub', () => {
    vi.stubEnv(MEMHUB_HOME_ENV, '');
    expect(getMemhubHome()).toBe(join(homedir(), '.memhub'));
  });

  it('honors the MEMHUB_HOME environment variable', () => {
    vi.stubEnv(MEMHUB_HOME_ENV, join('C:', 'tmp', 'memhub-alt'));
    expect(getMemhubHome()).toBe(join('C:', 'tmp', 'memhub-alt'));
  });

  it('ignores a whitespace-only MEMHUB_HOME override', () => {
    vi.stubEnv(MEMHUB_HOME_ENV, '   ');
    expect(getMemhubHome()).toBe(join(homedir(), '.memhub'));
  });

  it('derives database, token and log paths from the home directory', () => {
    const home = join('C:', 'data', 'memhub');
    expect(getDatabasePath(home)).toBe(join(home, 'memhub.db'));
    expect(getTokenPath(home)).toBe(join(home, 'token'));
    expect(getLogsDir(home)).toBe(join(home, 'logs'));
  });

  it('uses the resolved home when no argument is given', () => {
    vi.stubEnv(MEMHUB_HOME_ENV, join('C:', 'env-home'));
    expect(getDatabasePath()).toBe(join('C:', 'env-home', 'memhub.db'));
    expect(getTokenPath()).toBe(join('C:', 'env-home', 'token'));
    expect(getLogsDir()).toBe(join('C:', 'env-home', 'logs'));
  });

  it('exposes the default port', () => {
    expect(DEFAULT_PORT).toBe(7800);
  });

  it('derives the remaining home-relative paths', () => {
    const home = join('C:', 'data', 'memhub');
    expect(getSetupCodePath(home)).toBe(join(home, 'setup-code'));
    expect(getCredentialsPath(home)).toBe(join(home, 'credentials.json'));
    expect(getConfigPath(home)).toBe(join(home, 'config.json'));
    expect(getLanceDbPath(home)).toBe(join(home, 'lancedb'));
    expect(getModelsDir(home)).toBe(join(home, 'models'));
  });
});

describe('deployment env overrides', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('getBindHost', () => {
    it('defaults to 127.0.0.1', () => {
      vi.stubEnv(BIND_HOST_ENV, '');
      expect(getBindHost()).toBe('127.0.0.1');
    });

    it('honors MEMHUB_HOST', () => {
      vi.stubEnv(BIND_HOST_ENV, '0.0.0.0');
      expect(getBindHost()).toBe('0.0.0.0');
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

    it('honors MEMHUB_PORT', () => {
      vi.stubEnv(PORT_ENV, '9000');
      expect(getDefaultPort()).toBe(9000);
    });

    it('throws on an invalid MEMHUB_PORT', () => {
      vi.stubEnv(PORT_ENV, 'http');
      expect(() => getDefaultPort()).toThrow(/MEMHUB_PORT/);
    });
  });

  describe('getAllowedHosts', () => {
    it('returns an empty list when unset or blank', () => {
      expect(getAllowedHosts()).toEqual([]);
      vi.stubEnv(ALLOWED_HOSTS_ENV, '  ');
      expect(getAllowedHosts()).toEqual([]);
    });

    it('parses comma-separated hostnames, trimmed and lowercased', () => {
      vi.stubEnv(ALLOWED_HOSTS_ENV, 'MemHub.Example.com, localhost ,*');
      expect(getAllowedHosts()).toEqual(['memhub.example.com', 'localhost', '*']);
    });

    it('drops empty entries', () => {
      vi.stubEnv(ALLOWED_HOSTS_ENV, 'a.com,,b.com,');
      expect(getAllowedHosts()).toEqual(['a.com', 'b.com']);
    });
  });
});
