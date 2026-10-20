/**
 * The defaults of `memhub reindex` (src/cli/commands/reindex.ts).
 *
 * Without an injected embedder and vector store the command builds the
 * real ones: the Transformers.js provider for the model and the LanceDB
 * index for the vectors. This file checks that wiring - the heavy
 * packages are replaced by fakes, so no model is downloaded and no
 * vector table is opened.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../../src/db/database.js';

describe('the default embedder and vector store of memhub reindex', () => {
  const homes: string[] = [];

  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), 'memhub-reindex-defaults-'));
    homes.push(home);
    const db = openDatabase(join(home, 'memhub.db'));
    db.close();

    vi.resetModules();
    vi.doMock('../../../src/embedding/transformers-embedder.js', () => ({
      TransformersEmbedder: class {
        readonly modelId = 'fake-transformer-model';
        readonly dimensions = 8;
        async ensureLoaded(): Promise<void> {
          throw new Error('the fake model is not available');
        }
        async embed(): Promise<readonly number[][]> {
          return [];
        }
      },
    }));
    vi.doMock('../../../src/storage/vector-index.js', () => ({
      LanceVectorIndex: class {
        async initialize(): Promise<void> {}
        async upsert(): Promise<void> {}
        async clear(): Promise<void> {}
        async searchByVector(): Promise<never[]> {
          return [];
        }
      },
    }));
  });

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../../../src/embedding/transformers-embedder.js');
    vi.doUnmock('../../../src/storage/vector-index.js');
    vi.restoreAllMocks();
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('builds the default embedder and vector store', async () => {
    const { runReindexCommand } = await import('../../../src/cli/commands/reindex.js');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const code = await runReindexCommand({ home: homes[0] });

    expect(code).toBe(1);
    const output = error.mock.calls.flat().join('\n');
    expect(output).toContain('Reindex failed: the fake model is not available');
    // The default provider is the one that reports the model.
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('fake-transformer-model');
  });
});
