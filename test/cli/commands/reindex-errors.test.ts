/**
 * The failure paths of `memhub reindex` (src/cli/commands/reindex.ts).
 *
 * Two things are pinned down here: a rebuild that fails for a reason
 * other than a missing semantic stack is reported with its message (and
 * not with the install hint), and the command falls back to the home
 * directory of the environment when the caller does not name one.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../../src/db/database.js';
import { runReindexCommand } from '../../../src/cli/commands/reindex.js';
import { FakeEmbedder, FakeVectorStore, moduleNotFoundError } from '../../test-utils.js';

describe('the failure paths of memhub reindex', () => {
  const homes: string[] = [];

  function tempHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'memhub-reindex-errors-'));
    homes.push(home);
    return home;
  }

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('reports a rebuild that failed for another reason than a missing stack', async () => {
    const home = tempHome();
    const db = openDatabase(join(home, 'memhub.db'));
    db.close();

    const code = await runReindexCommand({
      home,
      vectors: new FakeVectorStore(),
      embedder: new FakeEmbedder({ failLoad: true, failLoadWith: new Error('model is corrupt') }),
    });

    expect(code).toBe(1);
    const messages = vi
      .mocked(console.error)
      .mock.calls.map(call => call.join(' '))
      .join('\n');
    expect(messages).toContain('Reindex failed: model is corrupt');
    expect(messages).not.toContain('the semantic stack is not installed');
  });

  it('reports a failure that is not an Error by its string form', async () => {
    const home = tempHome();
    const db = openDatabase(join(home, 'memhub.db'));
    db.close();

    const code = await runReindexCommand({
      home,
      vectors: new FakeVectorStore(),
      embedder: new FakeEmbedder({ failLoad: true, failLoadWith: 'the model is gone' }),
    });

    expect(code).toBe(1);
    const messages = vi
      .mocked(console.error)
      .mock.calls.map(call => call.join(' '))
      .join('\n');
    expect(messages).toContain('Reindex failed: the model is gone');
  });

  it('does not blame the semantic stack for a module that is not part of it', async () => {
    const home = tempHome();
    const db = openDatabase(join(home, 'memhub.db'));
    db.close();

    const code = await runReindexCommand({
      home,
      vectors: new FakeVectorStore(),
      embedder: new FakeEmbedder({
        failLoad: true,
        failLoadWith: moduleNotFoundError('some-user-plugin'),
      }),
    });

    expect(code).toBe(1);
    const messages = vi
      .mocked(console.error)
      .mock.calls.map(call => call.join(' '))
      .join('\n');
    expect(messages).not.toContain('the semantic stack is not installed');
    expect(messages).toContain("Cannot find package 'some-user-plugin'");
  });

  it('takes the data directory from the environment when none is given', async () => {
    const home = tempHome();
    const db = openDatabase(join(home, 'memhub.db'));
    db.close();
    vi.stubEnv('MEMHUB_HOME', home);

    const vectors = new FakeVectorStore();
    const code = await runReindexCommand({
      vectors,
      embedder: new FakeEmbedder(),
    });

    expect(code).toBe(0);
    expect(
      vi
        .mocked(console.log)
        .mock.calls.map(call => call.join(' '))
        .join('\n')
    ).toContain('Rebuilding the vector index');
  });
});
