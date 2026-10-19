import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isConfigKey,
  readConfig,
  setConfigValue,
  unsetConfigValue,
  writeConfig,
} from '../../src/cli/config-file.js';
import { getConfigPath } from '../../src/paths.js';

describe('config store', () => {
  const dirs: string[] = [];
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'memhub-config-'));
    dirs.push(home);
  });

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('recognizes supported keys', () => {
    expect(isConfigKey('base-url')).toBe(true);
    expect(isConfigKey('port')).toBe(false);
    expect(isConfigKey(undefined)).toBe(false);
  });

  it('round-trips a written config', () => {
    expect(readConfig(home)).toEqual({ version: 1 });
    writeConfig(home, { version: 1, base_url: 'https://x.example' });
    expect(readConfig(home)).toEqual({ version: 1, base_url: 'https://x.example' });
    if (process.platform !== 'win32') {
      expect(statSync(getConfigPath(home)).mode & 0o777).toBe(0o600);
    }
  });

  it('re-tightens the mode when rewriting a loosened config file', () => {
    writeConfig(home, { version: 1, base_url: 'https://x.example' });
    if (process.platform !== 'win32') {
      chmodSync(getConfigPath(home), 0o644);
    }
    writeConfig(home, { version: 1, base_url: 'https://y.example' });
    if (process.platform !== 'win32') {
      expect(statSync(getConfigPath(home)).mode & 0o777).toBe(0o600);
    }
    expect(readConfig(home).base_url).toBe('https://y.example');
  });

  it('treats malformed config files as empty', () => {
    writeFileSync(getConfigPath(home), 'not json', 'utf-8');
    expect(readConfig(home)).toEqual({ version: 1 });
    writeFileSync(getConfigPath(home), JSON.stringify({ version: 2, base_url: 'x' }));
    expect(readConfig(home)).toEqual({ version: 1 });
    writeFileSync(getConfigPath(home), JSON.stringify({ version: 1, base_url: 42 }));
    expect(readConfig(home)).toEqual({ version: 1 });
  });

  it('sets and unsets values', () => {
    expect(setConfigValue(home, 'base-url', 'https://x.example')).toEqual({
      version: 1,
      base_url: 'https://x.example',
    });
    expect(readConfig(home).base_url).toBe('https://x.example');
    unsetConfigValue(home, 'base-url');
    expect(readConfig(home)).toEqual({ version: 1 });
    // unset is idempotent and the file survives
    unsetConfigValue(home, 'base-url');
    expect(readConfig(home)).toEqual({ version: 1 });
  });
});
