/**
 * The defensive guard of the vector store (src/storage/vector-index.ts).
 *
 * A vector table that holds a row with a broken card id or a broken
 * distance must not produce a match: the search skips such a row
 * instead of handing a nonsense card id to the caller.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('@lancedb/lancedb');
  vi.restoreAllMocks();
});

/** A LanceDB module whose table always answers with the given rows. */
function lancedbWith(rows: readonly unknown[]): void {
  vi.doMock('@lancedb/lancedb', () => ({
    connect: async () => ({
      tableNames: async () => ['card_vectors'],
      openTable: async () => ({
        search: () => ({
          limit: () => ({
            toArray: async () => rows,
          }),
        }),
      }),
    }),
  }));
}

describe('a vector table with a broken row', () => {
  it('skips a row whose card id is not a number', async () => {
    lancedbWith([{ card_id: 'not-a-number', _distance: 0.5 }]);
    const { LanceVectorIndex } = await import('../../src/storage/vector-index.js');

    const index = new LanceVectorIndex('unused-path');
    expect(await index.searchByVector([1, 0, 0], 5)).toEqual([]);
  });

  it('skips a row whose distance is not finite', async () => {
    lancedbWith([{ card_id: 7, _distance: Number.POSITIVE_INFINITY }]);
    const { LanceVectorIndex } = await import('../../src/storage/vector-index.js');

    const index = new LanceVectorIndex('unused-path');
    expect(await index.searchByVector([1, 0, 0], 5)).toEqual([]);
  });
});
