import { describe, expect, it } from 'vitest';
import { isIndexReady } from '../../../src/core/policies/index-readiness.js';
import type { SemanticSearchBackend } from '../../../src/core/ports/search.js';

/** A semantic backend whose readiness the test controls. */
function backend(ready: boolean, notInstalled = false): SemanticSearchBackend {
  return { ready, notInstalled, search: async () => [] };
}

describe('isIndexReady', () => {
  it('follows the semantic backend when one is injected', () => {
    expect(isIndexReady(backend(false))).toBe(false);
    expect(isIndexReady(backend(true))).toBe(true);
  });

  it('ignores the model and the pending count when a backend is injected', () => {
    expect(isIndexReady(backend(false), 'model-id', 0)).toBe(false);
    expect(isIndexReady(backend(true), null, 12)).toBe(true);
  });

  it('falls back to the model and the pending count without a backend', () => {
    expect(isIndexReady(null, 'model-id', 0)).toBe(true);
    expect(isIndexReady(undefined, 'model-id', 0)).toBe(true);
    expect(isIndexReady(null, 'model-id', 3)).toBe(false);
    expect(isIndexReady(null, null, 0)).toBe(false);
  });

  it('is not ready without a model even when nothing is pending', () => {
    expect(isIndexReady(null, null, 0)).toBe(false);
    expect(isIndexReady(undefined)).toBe(false);
  });

  it('is not ready while cards are waiting to be embedded', () => {
    expect(isIndexReady(null, 'model-id', 1)).toBe(false);
  });

  it('defaults the model to null and the pending count to zero', () => {
    expect(isIndexReady(null)).toBe(false);
  });
});
