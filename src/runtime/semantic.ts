/**
 * The semantic stack, wired together.
 *
 * The embedder (embedding layer) and the vector store (storage layer)
 * are two independent registries. Putting them together is a composition
 * job, so it lives in the runtime layer - the one layer that is allowed
 * to know about both.
 */

import type { EmbeddingProvider } from '../core/ports/embedding.js';
import type { VectorStore } from '../core/ports/vector.js';
import { resolveEmbeddingProvider, type EmbeddingProviderId } from '../embedding/registry.js';
import { resolveVectorStore } from '../storage/registry.js';

/** The embedding side of the semantic stack, wired together. */
export interface SemanticStack {
  /** The provider that turns text into vectors. */
  readonly embedder: EmbeddingProvider;
  /** The store that holds the vectors. */
  readonly vectors: VectorStore;
}

/** Options for resolveSemanticStack(). */
export interface ResolveSemanticStackOptions {
  /** Directory where the model files are cached. */
  readonly cacheDir?: string | undefined;
  /** Directory the vector store keeps its data in. */
  readonly dbPath: string;
  /** Id of the embedding provider to use. */
  readonly providerId?: EmbeddingProviderId | undefined;
  /** Id of the vector store to use. */
  readonly storeId?: string | undefined;
  /** Embedding provider override (tests, plugins). */
  readonly embedder?: EmbeddingProvider | undefined;
  /** Vector store override (tests, plugins). */
  readonly vectors?: VectorStore | undefined;
}

/**
 * Create the embedder and its vector store together.
 *
 * The store is configured with the embedder's dimensionality, so a
 * provider that produces vectors of a different length than the one the
 * LanceDB table was created with is rejected on write instead of
 * silently corrupting the table schema.
 */
export function resolveSemanticStack(options: ResolveSemanticStackOptions): SemanticStack {
  const embedder =
    options.embedder ??
    resolveEmbeddingProvider({
      providerId: options.providerId,
      cacheDir: options.cacheDir,
    });
  const vectors =
    options.vectors ??
    resolveVectorStore({
      dbPath: options.dbPath,
      dimensions: embedder.dimensions,
      storeId: options.storeId,
    });
  return { embedder, vectors };
}
