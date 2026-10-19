/**
 * The production worker context of the daemon.
 *
 * The vector store the daemon writes into is configured with the
 * dimensionality of the embedding provider. Without that, a provider
 * that produces vectors of a different length would silently corrupt
 * the LanceDB table schema - the store would only complain when
 * LanceDB itself rejects the write.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultWorkerContext } from '../../src/daemon/start.js';
import { EMBEDDING_DIM } from '../../src/embedding/transformers-embedder.js';
import { VectorDimensionMismatchError } from '../../src/storage/vector-index.js';

describe('createDefaultWorkerContext', () => {
  const homes: string[] = [];

  function tempHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'memhub-worker-context-'));
    homes.push(home);
    return home;
  }

  afterEach(() => {
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('configures the vector store with the dimensionality of the embedder', async () => {
    const context = createDefaultWorkerContext(tempHome());
    expect(context.embedder.dimensions).toBe(EMBEDDING_DIM);

    // The store rejects a vector of the wrong length before it touches
    // LanceDB, so this needs neither the native module nor a database.
    const error = await context.vectors.upsert(1, [0.1, 0.2]).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(VectorDimensionMismatchError);
    expect((error as VectorDimensionMismatchError).message).toBe(
      `vector dimension mismatch: expected ${EMBEDDING_DIM}, got 2`
    );
  });
});
