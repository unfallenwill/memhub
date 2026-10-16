import { afterEach, describe, expect, it, vi } from 'vitest';
import { runStatusCommand } from '../../src/cli/status.js';

const healthBody = {
  app: 'memhub',
  pid: 4321,
  uptime: 120,
  version: '1.0.0',
  cards: { total: 10, active: 8, pending_index: 2 },
  queue: { pending_events: 3, oldest_unindexed_age_s: 45 },
  index: { ready: false, model: null },
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe('runStatusCommand', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('prints daemon details and exits 0 when running', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(healthBody))
    );

    const code = await runStatusCommand({ port: 7800 });
    expect(code).toBe(0);
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('MemHub server is running');
    expect(output).toContain('4321');
    expect(output).toContain('120s');
    expect(output).toContain('pending_index=2');
    expect(output).toContain('pending_events=3');
  });

  it('exits 1 when the daemon is not running', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      })
    );
    const code = await runStatusCommand({ port: 7800 });
    expect(code).toBe(1);
    expect(log.mock.calls.flat().join('\n')).toContain('not running');
  });

  it('exits 1 when another program answers', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ app: 'other' }))
    );
    expect(await runStatusCommand({ port: 7800 })).toBe(1);
  });
});
