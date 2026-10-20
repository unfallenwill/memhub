/**
 * The vector store `memhub reindex` writes into.
 *
 * The store is configured with the dimensionality of the embedding
 * provider, so a provider that produces vectors of a different length
 * than the table was created with is rejected instead of silently
 * corrupting the table schema.
 *
 * The native LanceDB module is replaced by a fake, so the test never
 * loads native binaries and never touches the disk.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const created = vi.hoisted(() => ({
  stores: [] as { dbPath: string; options: { dimensions?: number | undefined } }[],
}));

vi.mock('../../../src/storage/vector-index.js', () => {
  class FakeLanceVectorIndex {
    constructor(dbPath: string, options: { dimensions?: number | undefined } = {}) {
      created.stores.push({ dbPath, options });
    }
    async initialize(): Promise<void> {}
    async upsert(): Promise<void> {}
    async clear(): Promise<void> {}
    async searchByVector(): Promise<readonly never[]> {
      return [];
    }
  }
  return { LanceVectorIndex: FakeLanceVectorIndex, CARD_VECTORS_TABLE: 'card_vectors' };
});

const { runReindexCommand } = await import('../../../src/cli/commands/reindex.js');
const { openDatabase } = await import('../../../src/db/database.js');
const { FakeEmbedder } = await import('../../test-utils.js');

describe('the vector store of memhub reindex', () => {
  const homes: string[] = [];

  function tempHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'memhub-reindex-dimensions-'));
    homes.push(home);
    const db = openDatabase(join(home, 'memhub.db'));
    db.close();
    return home;
  }

  beforeEach(() => {
    created.stores.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('is configured with the dimensionality of the embedder', async () => {
    const home = tempHome();
    const embedder = new FakeEmbedder();

    const code = await runReindexCommand({ home, embedder });

    expect(code).toBe(0);
    expect(created.stores).toHaveLength(1);
    expect(created.stores[0].options.dimensions).toBe(embedder.dimensions);
  });

  it('does not build a store when the caller brings its own', async () => {
    const home = tempHome();

    const code = await runReindexCommand({
      home,
      embedder: new FakeEmbedder(),
      vectors: {
        initialize: async () => {},
        upsert: async () => {},
        clear: async () => {},
        searchByVector: async () => [],
      },
    });

    expect(code).toBe(0);
    expect(created.stores).toHaveLength(0);
  });
});
