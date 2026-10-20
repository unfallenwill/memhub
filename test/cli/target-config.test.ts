/**
 * The config lookup of the target resolution (src/cli/target.ts).
 *
 * A config file that cannot be read blocks the command instead of
 * rerouting it to the local daemon. The reason is reported as a string
 * when the failure is not an Error.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../../src/cli/config-file.js');
  vi.restoreAllMocks();
});

describe('a config file that cannot be read', () => {
  it('reports the reason of a failure that is not an Error', async () => {
    vi.doMock('../../src/cli/config-file.js', () => ({
      readConfig: () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw 'the config file is on fire';
      },
    }));
    const { resolveCommandTarget } = await import('../../src/cli/target.js');

    const target = resolveCommandTarget({ port: 7800, home: 'C:/memhub-home' });

    expect(target).toEqual({ kind: 'error', message: 'the config file is on fire' });
  });
});
