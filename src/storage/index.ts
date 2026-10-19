/**
 * Derived storage: vector index for semantic search.
 */

export type { CardVectorStore, VectorMatch } from './vector-index.js';
export { CARD_VECTORS_TABLE, LanceVectorIndex } from './vector-index.js';
export {
  DEFAULT_VECTOR_STORE_ID,
  VECTOR_STORE_REGISTRY,
  resolveVectorStore,
  type ResolveVectorStoreOptions,
  type VectorStoreOptions,
  type VectorStoreRegistration,
} from './registry.js';
