import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIM } from '../../src/embedding/transformers-embedder.js';
import { resolveSemanticStack } from '../../src/runtime/semantic.js';
import { FakeEmbedder, FakeVectorStore } from '../test-utils.js';

describe('resolveSemanticStack', () => {
  it('wires the embedder dimensions into the vector store', async () => {
    const stack = resolveSemanticStack({ dbPath: '/tmp/x', cacheDir: '/tmp/models' });
    expect(stack.embedder.dimensions).toBe(EMBEDDING_DIM);
    await expect(stack.vectors.upsert(1, [0.1, 0.2])).rejects.toThrow(
      `vector dimension mismatch: expected ${EMBEDDING_DIM}, got 2`
    );
  });

  it('uses the dimensions of an injected embedder', async () => {
    const embedder = new FakeEmbedder();
    const stack = resolveSemanticStack({ dbPath: '/tmp/x', embedder });
    expect(stack.embedder).toBe(embedder);
    await expect(stack.vectors.upsert(1, [0.1, 0.2, 0.3])).rejects.toThrow(
      'vector dimension mismatch: expected 8, got 3'
    );
  });

  it('uses an injected vector store as-is', async () => {
    const vectors = new FakeVectorStore();
    const stack = resolveSemanticStack({ dbPath: '/tmp/x', vectors });
    expect(stack.vectors).toBe(vectors);
    await expect(stack.vectors.upsert(1, [0.1])).resolves.toBeUndefined();
  });
});
