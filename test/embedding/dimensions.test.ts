import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMBEDDING_DIM, TransformersEmbedder } from '../../src/embedding/transformers-embedder.js';
import { LanceVectorIndex, VectorDimensionMismatchError } from '../../src/storage/vector-index.js';

/**
 * The native LanceDB module is replaced by a fake so the dimension
 * handling can be tested without loading native binaries. The real
 * storage layer is covered by test/storage/vector-index.test.ts.
 */
const lancedb = vi.hoisted(() => {
  const table = {
    delete: vi.fn(async () => undefined),
    add: vi.fn(async () => undefined),
    search: vi.fn(() => ({ limit: () => ({ toArray: async () => [] }) })),
  };
  const connection = {
    tableNames: vi.fn(async () => [] as string[]),
    openTable: vi.fn(async () => table),
    createTable: vi.fn(async () => table),
    dropTable: vi.fn(async () => undefined),
  };
  return { table, connection, connect: vi.fn(async () => connection) };
});

vi.mock('@lancedb/lancedb', () => ({ connect: lancedb.connect }));

describe('embedding dimensions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('the transformers provider reports the model dimensionality', () => {
    const embedder = new TransformersEmbedder();
    expect(embedder.dimensions).toBe(EMBEDDING_DIM);
    expect(EMBEDDING_DIM).toBe(384);
  });

  it('rejects a vector whose length does not match the configured dimensions', async () => {
    const index = new LanceVectorIndex('/tmp/memhub-lancedb', { dimensions: 384 });
    const error = await index.upsert(1, [0.1, 0.2, 0.3]).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(VectorDimensionMismatchError);
    expect((error as VectorDimensionMismatchError).message).toBe(
      'vector dimension mismatch: expected 384, got 3'
    );
    expect((error as VectorDimensionMismatchError).expected).toBe(384);
    expect((error as VectorDimensionMismatchError).actual).toBe(3);
  });

  it('rejects a mismatching vector before touching the store', async () => {
    const index = new LanceVectorIndex('/tmp/memhub-lancedb', { dimensions: 384 });
    await expect(index.upsert(1, [0.1, 0.2, 0.3])).rejects.toThrow(
      'vector dimension mismatch: expected 384, got 3'
    );
    expect(lancedb.connect).not.toHaveBeenCalled();
  });

  it('accepts a vector with the configured length', async () => {
    const index = new LanceVectorIndex('/tmp/memhub-lancedb', { dimensions: 3 });
    await expect(index.upsert(1, [0.1, 0.2, 0.3])).resolves.toBeUndefined();
    expect(lancedb.connection.createTable).toHaveBeenCalledTimes(1);
  });

  it('does not validate when no dimensions are configured', async () => {
    const index = new LanceVectorIndex('/tmp/memhub-lancedb');
    await expect(index.upsert(1, [0.1])).resolves.toBeUndefined();
    expect(lancedb.connection.createTable).toHaveBeenCalledTimes(1);
  });
});
