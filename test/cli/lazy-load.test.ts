/**
 * The CLI must not drag the daemon into a command that only talks HTTP.
 *
 * `memhub add` writes one card: it needs the HTTP client and nothing
 * else. Pulling in Hono (the daemon's web framework), Zod or SQLite
 * would make every agent-side call pay for the whole server.
 *
 * The check is a runtime one: both modules are mocked with a factory
 * that records the call. A module that is never imported never runs
 * its factory, so the recording proves that the import graph of the
 * command does not contain it.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { loaded } = vi.hoisted(() => ({ loaded: { hono: 0, sqlite: 0 } }));

vi.mock('hono', () => {
  loaded.hono += 1;
  return {};
});

vi.mock('node:sqlite', () => {
  loaded.sqlite += 1;
  return {};
});

const homes: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  while (homes.length > 0) {
    const home = homes.pop();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  }
});

/** An empty data directory: no token, so no daemon is contacted. */
function emptyHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'memhub-lazy-'));
  homes.push(home);
  return home;
}

describe('the lazy command modules', () => {
  it('does not load the web framework for the add command', async () => {
    await import('../../src/cli/commands/add.js');
    expect(loaded.hono).toBe(0);
    expect(loaded.sqlite).toBe(0);
  });

  it('does not load the web framework for the search command', async () => {
    await import('../../src/cli/commands/search.js');
    expect(loaded.hono).toBe(0);
    expect(loaded.sqlite).toBe(0);
  });

  it('does not load the web framework when the registry dispatches add', async () => {
    vi.stubEnv('MEMHUB_HOME', emptyHome());
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { dispatch } = await import('../../src/cli/registry.js');
    // No token in the data directory: the command stops before it talks
    // to a daemon, but its modules are already resolved.
    await dispatch(['add', '--title', 'T', '--body', 'B']);
    expect(loaded.hono).toBe(0);
    expect(loaded.sqlite).toBe(0);
  });

  it('keeps the registry itself free of the daemon', async () => {
    await import('../../src/cli/registry.js');
    expect(loaded.hono).toBe(0);
    expect(loaded.sqlite).toBe(0);
  });

  it('would notice a module that is loaded', async () => {
    // The check above only means something when the recording works.
    await import('hono');
    expect(loaded.hono).toBeGreaterThan(0);
  });
});
