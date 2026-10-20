/**
 * Argument parsing of the CLI commands.
 *
 * Every command parses its flags through src/cli/options.ts, but each
 * command has its own vocabulary (which flags it knows, which wording it
 * uses for a usage error). These tests pin that vocabulary down: the
 * "unknown option" branch of every command, the "--port" branch of the
 * commands that talk to a local daemon, and the "flag without a value"
 * branch of the flags that carry a value.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseAddArgs } from '../../../src/cli/commands/add.js';
import { parseConfigArgs } from '../../../src/cli/commands/config.js';
import { parseLogoutArgs } from '../../../src/cli/commands/logout.js';
import { parseReindexArgs } from '../../../src/cli/commands/reindex.js';
import { parseResetPasswordArgs } from '../../../src/cli/commands/reset-password.js';
import { parseSearchArgs } from '../../../src/cli/commands/search.js';
import { parseStatusArgs } from '../../../src/cli/commands/status.js';
import { parseStopArgs } from '../../../src/cli/commands/stop.js';

describe('parseReindexArgs', () => {
  it('accepts no arguments at all', () => {
    expect(parseReindexArgs([])).toEqual({});
  });

  it('rejects every argument: the command has no flags', () => {
    expect(() => parseReindexArgs(['--force'])).toThrow('unknown option for reindex: --force');
    expect(() => parseReindexArgs(['--port', '7800'])).toThrow('unknown option for reindex');
  });
});

describe('parseStatusArgs', () => {
  let savedPort: string | undefined;

  beforeEach(() => {
    savedPort = process.env.MEMHUB_PORT;
    delete process.env.MEMHUB_PORT;
  });

  afterEach(() => {
    if (savedPort === undefined) delete process.env.MEMHUB_PORT;
    else process.env.MEMHUB_PORT = savedPort;
  });

  it('falls back to the default port', () => {
    expect(parseStatusArgs([]).port).toBe(7800);
  });

  it('reads the port from --port', () => {
    expect(parseStatusArgs(['--port', '9000']).port).toBe(9000);
  });

  it('reads the port from the short form -p', () => {
    expect(parseStatusArgs(['-p', '9100']).port).toBe(9100);
  });

  it('reads the default port from MEMHUB_PORT', () => {
    process.env.MEMHUB_PORT = '8123';
    expect(parseStatusArgs([]).port).toBe(8123);
  });

  it('rejects an invalid port', () => {
    expect(() => parseStatusArgs(['--port', '0'])).toThrow('invalid --port value: 0');
    expect(() => parseStatusArgs(['--port', '70000'])).toThrow('invalid --port value');
  });

  it('rejects an unknown option', () => {
    expect(() => parseStatusArgs(['--nope'])).toThrow('unknown option for status: --nope');
  });
});

describe('parseStopArgs', () => {
  let savedPort: string | undefined;

  beforeEach(() => {
    savedPort = process.env.MEMHUB_PORT;
    delete process.env.MEMHUB_PORT;
  });

  afterEach(() => {
    if (savedPort === undefined) delete process.env.MEMHUB_PORT;
    else process.env.MEMHUB_PORT = savedPort;
  });

  it('falls back to the default port', () => {
    expect(parseStopArgs([]).port).toBe(7800);
  });

  it('reads the port from --port', () => {
    expect(parseStopArgs(['--port', '9000']).port).toBe(9000);
  });

  it('reads the port from the short form -p', () => {
    expect(parseStopArgs(['-p', '9100']).port).toBe(9100);
  });

  it('rejects an invalid port', () => {
    expect(() => parseStopArgs(['--port', 'abc'])).toThrow('invalid --port value: abc');
  });

  it('rejects an unknown option', () => {
    expect(() => parseStopArgs(['--nope'])).toThrow('unknown option for stop: --nope');
  });
});

describe('parseResetPasswordArgs', () => {
  it('accepts no arguments at all', () => {
    expect(parseResetPasswordArgs([])).toEqual({});
  });

  it('rejects every argument: the command has no flags', () => {
    expect(() => parseResetPasswordArgs(['--force'])).toThrow(
      'unknown option for reset-password: --force'
    );
  });
});

describe('parseLogoutArgs', () => {
  it('accepts no arguments at all', () => {
    expect(parseLogoutArgs([])).toEqual({});
  });

  it('rejects every argument: the command has no flags', () => {
    expect(() => parseLogoutArgs(['--force'])).toThrow('unknown option for logout: --force');
  });
});

describe('parseAddArgs', () => {
  it('reports a missing --type value as "(missing)"', () => {
    expect(() => parseAddArgs(['--title', 't', '--type'])).toThrow(
      'invalid --type value: (missing)'
    );
  });

  it('reports the allowed card types', () => {
    expect(() => parseAddArgs(['--title', 't', '--type', 'nope'])).toThrow(
      'expected one of fact, preference, decision, insight, pattern'
    );
  });

  it('accepts every documented card type', () => {
    for (const type of ['fact', 'preference', 'decision', 'insight', 'pattern']) {
      expect(parseAddArgs(['--title', 't', '--type', type]).type).toBe(type);
    }
  });
});

describe('parseSearchArgs', () => {
  it('reports a missing --mode value as "(missing)"', () => {
    expect(() => parseSearchArgs(['q', '--mode'])).toThrow('invalid --mode value: (missing)');
  });

  it('reports a missing --limit value as "(missing)"', () => {
    expect(() => parseSearchArgs(['q', '--limit'])).toThrow('invalid --limit value: (missing)');
  });

  it('rejects a limit outside 1..100', () => {
    expect(() => parseSearchArgs(['q', '--limit', '0'])).toThrow('invalid --limit value: 0');
    expect(() => parseSearchArgs(['q', '--limit', '101'])).toThrow('invalid --limit value: 101');
  });
});

describe('parseConfigArgs', () => {
  it('parses the four subcommands', () => {
    expect(parseConfigArgs(['list'])).toEqual({ action: 'list' });
    expect(parseConfigArgs(['set', 'base-url', 'https://x.example'])).toEqual({
      action: 'set',
      key: 'base-url',
      value: 'https://x.example',
    });
    expect(parseConfigArgs(['get', 'base-url'])).toEqual({ action: 'get', key: 'base-url' });
    expect(parseConfigArgs(['unset', 'base-url'])).toEqual({ action: 'unset', key: 'base-url' });
  });
});
