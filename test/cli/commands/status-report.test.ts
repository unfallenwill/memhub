/**
 * The report of `memhub status` (src/cli/commands/status.ts).
 *
 * The command prints the daemon's /healthz payload in a human readable
 * form. The index line has two branches: a ready index with a known
 * model and an index that is not ready (or has no model at all).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { runStatusCommand } from '../../../src/cli/commands/status.js';

const HEALTH = {
  app: 'memhub',
  pid: 4321,
  uptime: 120,
  version: '1.0.0',
  cards: { total: 10, active: 8, pending_index: 2 },
  queue: { pending_events: 3, oldest_unindexed_age_s: 45 },
  index: { ready: true, model: 'all-MiniLM-L6-v2' },
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe('runStatusCommand report', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reports a ready index with its model', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(HEALTH))
    );

    const code = await runStatusCommand({ port: 7800 });

    expect(code).toBe(0);
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('index:   ready');
    expect(output).toContain('all-MiniLM-L6-v2');
  });

  it('reports an index that is not ready and has no model', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ ...HEALTH, index: { ready: false, model: null } }))
    );

    const code = await runStatusCommand({ port: 7800 });

    expect(code).toBe(0);
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('index:   not ready');
    expect(output).toContain('model: none');
  });
});
