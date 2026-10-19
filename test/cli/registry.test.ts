import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMMANDS, dispatch, renderUsage } from '../../src/cli/registry.js';
import { getVersion } from '../../src/version.js';

/** The usage lines the CLI showed before the help text was generated. */
const LEGACY_USAGE_LINES = [
  'memhub server [--port 7800] [--foreground]',
  'memhub status [--port 7800]',
  'memhub stop [--port 7800]',
  'memhub reindex',
  'memhub add [options]',
  'memhub search <query> [options]',
  'memhub login [--base-url <url>]',
  'memhub logout',
  'memhub config <set|get|list|unset> [key]',
  'memhub reset-password',
  'memhub --help',
  'memhub --version',
  '--port, -p <number>',
  '--foreground, -f',
  '--title <text>',
  '--body <text>',
  '--type <type>',
  '--cues <text>',
  '--writer <name>',
  '--base-url <url>',
  '--mode <mode>',
  '--limit <number>',
  'MEMHUB_HOME',
  'MEMHUB_HOST',
  'MEMHUB_PORT',
  'MEMHUB_TOKEN',
  'MEMHUB_ALLOWED_HOSTS',
  'Target resolution for add/search: --base-url and --port are mutually',
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../../src/cli/commands/logout.js');
});

describe('the command registry', () => {
  it('describes every command exactly once', () => {
    const names = COMMANDS.map(command => command.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([
      'server',
      'status',
      'stop',
      'reindex',
      'add',
      'search',
      'login',
      'logout',
      'config',
      'reset-password',
    ]);
  });

  it('gives every command a summary and a usage line', () => {
    for (const command of COMMANDS) {
      expect(command.summary.length, command.name).toBeGreaterThan(0);
      expect(command.usage.startsWith(command.name), command.name).toBe(true);
    }
  });

  it('generates the help text from the command table', () => {
    const usage = renderUsage();
    expect(usage).toContain('Usage:');
    expect(usage).toContain(`MemHub CLI v${getVersion()}`);
    for (const command of COMMANDS) {
      expect(usage, command.name).toContain(`memhub ${command.usage}`);
      expect(usage, command.name).toContain(command.summary);
    }
  });

  it('keeps every piece of information the hand-written usage had', () => {
    const usage = renderUsage();
    for (const line of LEGACY_USAGE_LINES) {
      expect(usage, line).toContain(line);
    }
  });

  it('documents the options of the commands that have their own', () => {
    const usage = renderUsage();
    expect(usage).toContain('memhub add options:');
    expect(usage).toContain('memhub search options:');
    expect(usage).toContain('Options:');
    expect(usage).toContain('Environment:');
  });
});

describe('dispatch', () => {
  it('prints the usage and exits 1 without a command', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await dispatch([]);
    expect(code).toBe(1);
    expect(log.mock.calls.flat().join('\n')).toContain('Usage:');
  });

  it('prints the usage and exits 0 for --help', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const flag of ['--help', '-h']) {
      const code = await dispatch([flag]);
      expect(code, flag).toBe(0);
      expect(log.mock.calls.flat().join('\n')).toContain('memhub add');
    }
  });

  it('prints the version and exits 0 for --version', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const flag of ['--version', '-v']) {
      const code = await dispatch([flag]);
      expect(code, flag).toBe(0);
      expect(log.mock.calls.flat().join('\n')).toContain(`MemHub CLI v${getVersion()}`);
    }
  });

  it('reports an unknown command on stderr and exits 1', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await dispatch(['bogus']);
    expect(code).toBe(1);
    const output = error.mock.calls.flat().join('\n');
    expect(output).toContain('Unknown command');
    expect(output).toContain('bogus');
    expect(output).toContain('memhub --help');
    expect(log).not.toHaveBeenCalled();
  });

  it('rejects an unknown option for every command', async () => {
    for (const command of COMMANDS) {
      await expect(dispatch([command.name, '--nope']), command.name).rejects.toThrow();
    }
  });

  it('rejects --base-url together with --port', async () => {
    await expect(
      dispatch(['add', '--title', 'T', '--base-url', 'https://x.example', '--port', '7900'])
    ).rejects.toThrow('mutually exclusive');
    await expect(
      dispatch(['search', 'q', '--base-url', 'https://x.example', '--port', '7900'])
    ).rejects.toThrow('mutually exclusive');
  });

  it('reports a command that cannot be loaded and exits 1', async () => {
    vi.doMock('../../src/cli/commands/logout.js', () => {
      throw new Error('module is broken');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await dispatch(['logout']);
    expect(code).toBe(1);
    const output = error.mock.calls.flat().join('\n');
    expect(output).toContain('cannot load the "logout" command');
  });
});
