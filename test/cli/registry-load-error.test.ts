/**
 * The load failure path of the command registry (src/cli/registry.ts).
 *
 * The registry loads every implementation lazily. When the loader
 * rejects, the CLI must report the problem and exit 1 - with the
 * message of the rejection when it is an Error and with its string
 * form when it is not.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatch } from '../../src/cli/registry.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../../src/cli/commands/logout.js');
  vi.doUnmock('../../src/cli/commands/config.js');
});

describe('a command implementation that cannot be loaded', () => {
  it('reports the message of a rejected Error', async () => {
    vi.doMock('../../src/cli/commands/logout.js', () => {
      throw new Error('module is broken');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const code = await dispatch(['logout']);

    expect(code).toBe(1);
    const output = error.mock.calls.flat().join('\n');
    expect(output).toContain('cannot load the "logout" command');
  });

  it('reports a rejection that is not an Error by its string form', async () => {
    vi.doMock('../../src/cli/commands/config.js', () => ({
      // The registry reads the command off the loaded module: a getter
      // that throws a non-Error makes the loader reject with that value.
      get configCommand(): never {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw 'not an error';
      },
    }));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const code = await dispatch(['config', 'list']);

    expect(code).toBe(1);
    const output = error.mock.calls.flat().join('\n');
    expect(output).toContain('cannot load the "config" command');
    expect(output).toContain('not an error');
  });
});
