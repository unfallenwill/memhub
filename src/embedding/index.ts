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
