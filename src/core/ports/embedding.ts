/**
 * Embedding provider port.
 *
 * Production uses Transformers.js (a local ONNX model); tests inject fake
 * providers so no model is ever downloaded during the test suite. The
 * provider is the only place that knows the model identity, which the
 * worker records in worker_state to detect model changes.
 */

/**
 * A text embedding backend.
 * Implementations must be safe to call concurrently from the worker and
 * the HTTP search path.
 */
export interface EmbeddingProvider {
  /** Stable identity of the embedding model (recorded in worker_state). */
  readonly modelId: string;
  /** Vector dimensionality; callers validate vectors against it. */
  readonly dimensions: number;
  /**
   * Load the model. Idempotent; the first call may download the model,
   * later calls reuse it. Rejects when the model cannot be loaded.
   */
  ensureLoaded(): Promise<void>;
  /**
   * Embed a batch of texts in one inference call (burst writes are
   * embedded together). Returns exactly one vector per input text.
   */
  embed(texts: readonly string[]): Promise<readonly number[][]>;
}
