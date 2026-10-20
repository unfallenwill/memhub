/**
 * Vector store registry.
 *
 * The concrete vector store used by the daemon used to be hard-coded in
 * two places (the daemon bootstrap and the CLI reindex command), so
 * adding a third implementation meant touching both. They are
 * registered here instead: a store is described once, in this file, and
 * selected by id.
 *
 * The registry is pure. It never imports @lancedb/lancedb eagerly: the
 * implementation itself imports the package lazily, so a keyword-only
 * installation never pays for it.
 *
 * The registry lives in the storage layer because a vector store is a
 * storage concern; the embedding layer knows nothing about it.
 */

import type { VectorStore } from '../core/ports/vector.js';
import { LanceVectorIndex } from './vector-index.js';

/** Options for a vector store factory. */
export interface VectorStoreOptions {
  /** Directory the store keeps its data in. */
  readonly dbPath: string;
  /** Expected vector dimensionality; when set, writes are validated. */
  readonly dimensions?: number | undefined;
}

/** A registered vector store implementation. */
export interface VectorStoreRegistration {
  /** Stable id used to select the store. */
  readonly id: string;
  /** Create a store instance. */
  readonly create: (options: VectorStoreOptions) => VectorStore;
}

/** Id of the vector store used when no store is requested explicitly. */
export const DEFAULT_VECTOR_STORE_ID = 'lancedb';

/** The built-in vector stores. */
export const VECTOR_STORE_REGISTRY: readonly VectorStoreRegistration[] = [
  {
    id: DEFAULT_VECTOR_STORE_ID,
    create: options => new LanceVectorIndex(options.dbPath, { dimensions: options.dimensions }),
  },
];

/** Options for resolveVectorStore(). */
export interface ResolveVectorStoreOptions {
  /** Directory the store keeps its data in. */
  readonly dbPath: string;
  /** Expected vector dimensionality (usually the embedder's dimensions). */
  readonly dimensions?: number | undefined;
  /** Id of the store implementation. Defaults to the default store. */
  readonly storeId?: string | undefined;
  /** Registry to resolve from. Defaults to the built-in registry. */
  readonly registry?: readonly VectorStoreRegistration[] | undefined;
}

/**
 * Create the vector store selected by id.
 * Throws when the id is not registered.
 */
export function resolveVectorStore(options: ResolveVectorStoreOptions): VectorStore {
  const registry = options.registry ?? VECTOR_STORE_REGISTRY;
  const storeId = options.storeId ?? DEFAULT_VECTOR_STORE_ID;
  const registration = registry.find(entry => entry.id === storeId);
  if (registration === undefined) {
    throw new Error(`unknown vector store: ${storeId}`);
  }
  return registration.create({ dbPath: options.dbPath, dimensions: options.dimensions });
}
