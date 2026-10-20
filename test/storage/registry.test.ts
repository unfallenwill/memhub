import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VECTOR_STORE_ID,
  VECTOR_STORE_REGISTRY,
  resolveVectorStore,
  type VectorStoreRegistration,
} from '../../src/storage/registry.js';
import { FakeVectorStore } from '../test-utils.js';

describe('resolveVectorStore', () => {
  it('creates the default store', () => {
    const store = resolveVectorStore({ dbPath: '/tmp/memhub-lancedb' });
    expect(store).toBeDefined();
    expect(typeof store.upsert).toBe('function');
  });

  it('rejects an unregistered store id', () => {
    expect(() => resolveVectorStore({ dbPath: '/tmp/x', storeId: 'nope' })).toThrow(
      'unknown vector store: nope'
    );
  });

  it('uses a custom registry instead of the built-in one', () => {
    const fake: VectorStoreRegistration = {
      id: 'fake',
      create: () => new FakeVectorStore(),
    };
    const store = resolveVectorStore({ dbPath: '/tmp/x', storeId: 'fake', registry: [fake] });
    expect(store).toBeInstanceOf(FakeVectorStore);
  });

  it('registers the built-in store under the default id', () => {
    expect(VECTOR_STORE_REGISTRY.map(entry => entry.id)).toContain(DEFAULT_VECTOR_STORE_ID);
  });

  it('configures the store with the expected dimensions', async () => {
    const store = resolveVectorStore({ dbPath: '/tmp/x', dimensions: 384 });
    await expect(store.upsert(1, [0.1, 0.2, 0.3])).rejects.toThrow(
      'vector dimension mismatch: expected 384, got 3'
    );
  });
});
