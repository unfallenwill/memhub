/**
 * Embedding layer: turning card text and queries into vectors.
 */

export type { EmbeddingProvider } from './embedder.js';
export {
  EMBEDDING_DIM,
  EMBEDDING_MODEL_ID,
  TransformersEmbedder,
  type TransformersEmbedderOptions,
} from './transformers-embedder.js';
export {
  DEFAULT_EMBEDDING_PROVIDER_ID,
  EMBEDDING_PROVIDER_REGISTRY,
  missingSemanticPackage,
  resolveEmbeddingProvider,
  type EmbeddingProviderId,
  type EmbeddingProviderOptions,
  type EmbeddingProviderRegistration,
  type ResolveEmbeddingProviderOptions,
  type SemanticStackPackage,
} from './registry.js';
