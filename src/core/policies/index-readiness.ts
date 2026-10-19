/**
 * Whether the vector index is ready for semantic search.
 *
 * When a semantic backend is injected, its readiness flag is
 * authoritative (the daemon flips it once the worker loaded the model
 * and prepared the vector table). Without one, fall back to the recorded
 * model plus the pending index count: the index is only usable when a
 * model was recorded and nothing is waiting to be embedded.
 *
 * This is the single source of truth for the readiness question: the
 * service and the HTTP adapter (GET /healthz) both ask it.
 */

import type { SemanticSearchBackend } from '../ports/search.js';

/**
 * @param semantic The semantic backend, when one is available.
 * @param model The embedding model recorded by the worker.
 * @param pendingIndex The number of active cards still waiting to be embedded.
 */
export function isIndexReady(
  semantic: SemanticSearchBackend | null | undefined,
  model: string | null = null,
  pendingIndex = 0
): boolean {
  if (semantic !== null && semantic !== undefined) {
    return semantic.ready;
  }
  return model !== null && pendingIndex === 0;
}
