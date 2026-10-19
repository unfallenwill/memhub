import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConfigArgs, runConfigCommand } from '../../src/cli/config.js';
import { readConfig } from '../../src/cli/config-file.js';

describe('parseConfigArgs', () => {
  it('parses the four subcommands', () => {
    expect(parseConfigArgs(['set', 'base-url', 'https://x.example'])).toEqual({
      action: 'set',
      key: 'base-url',
      value: 'https://x.example',
    });
    expect(parseConfigArgs(['get', 'base-url'])).toEqual({
      action: 'get',
      key: 'base-url',
    });
    expect(parseConfigArgs(['unset', 'base-url'])).toEqual({
      action: 'unset',
      key: 'base-url',
    });
    expect(parseConfigArgs(['list'])).toEqual({ action: 'list' });
  });

  it('rejects missing or unknown subcommands', () => {
    expect(() => parseConfigArgs([])).toThrow(/usage/);
    expect(() => parseConfigArgs(['show'])).toThrow(/usage/);
  });

  it('rejects a bad arity and unknown keys', () => {
    expect(() => parseConfigArgs(['set', 'base-url'])).toThrow(/usage/);
    expect(() => parseConfigArgs(['set', 'base-url', 'x', 'y'])).toThrow(/usage/);
    expect(() => parseConfigArgs(['set', 'port', '7800'])).toThrow('unknown config key: port');
    expect(() => parseConfigArgs(['get', 'port'])).toThrow('unknown config key: port');
    expect(() => parseConfigArgs(['get', 'base-url', 'extra'])).toThrow(/usage/);
    expect(() => parseConfigArgs(['list', 'base-url'])).toThrow(/usage/);
  });
});

describe('runConfigCommand', () => {
  const dirs: string[] = [];
  let home: string;
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'memhub-config-cmd-'));
    dirs.push(home);
    logs = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => logs.push(args.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) =>
      errors.push(args.join(' '))
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('set normalizes the URL before storing', () => {
    expect(
      runConfigCommand({ action: 'set', key: 'base-url', value: 'https://x.example/sub', home })
    ).toBe(0);
    expect(readConfig(home).base_url).toBe('https://x.example');
    expect(logs.join('\n')).toContain('base-url = https://x.example');
  });

  it('set rejects an invalid URL with exit code 1', () => {
    expect(runConfigCommand({ action: 'set', key: 'base-url', value: 'nonsense', home })).toBe(1);
    expect(errors.join('\n')).toContain('invalid base URL');
    expect(readConfig(home)).toEqual({ version: 1 });
  });

  it('get prints the value or exits 1 when unset', () => {
    expect(runConfigCommand({ action: 'get', key: 'base-url', home })).toBe(1);
    expect(errors.join('\n')).toContain('not set');
    expect(logs).toEqual([]);
    runConfigCommand({ action: 'set', key: 'base-url', value: 'https://x.example', home });
    logs.length = 0;
    expect(runConfigCommand({ action: 'get', key: 'base-url', home })).toBe(0);
    expect(logs).toEqual(['https://x.example']);
  });

  it('list prints set keys as key=value lines', () => {
    expect(runConfigCommand({ action: 'list', home })).toBe(0);
    expect(logs).toEqual([]);
    runConfigCommand({ action: 'set', key: 'base-url', value: 'https://x.example', home });
    logs.length = 0;
    expect(runConfigCommand({ action: 'list', home })).toBe(0);
    expect(logs).toEqual(['base-url=https://x.example']);
  });

  it('unset is idempotent', () => {
    runConfigCommand({ action: 'set', key: 'base-url', value: 'https://x.example', home });
    logs.length = 0;
    expect(runConfigCommand({ action: 'unset', key: 'base-url', home })).toBe(0);
    expect(readConfig(home)).toEqual({ version: 1 });
    expect(logs.join('\n')).toContain('unset');
    expect(runConfigCommand({ action: 'unset', key: 'base-url', home })).toBe(0);
    expect(logs.join('\n')).toContain('was not set');
  });
});
