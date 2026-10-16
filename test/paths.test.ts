import { homedir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PORT,
  getDatabasePath,
  getLogsDir,
  getMemhubHome,
  getTokenPath,
  MEMHUB_HOME_ENV,
} from '../src/paths.js';

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
});
