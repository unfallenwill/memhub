/**
 * Embedding provider registry.
 *
 * The concrete embedder used by the daemon used to be hard-coded in two
 * places (the daemon bootstrap and the CLI reindex command), so adding a
 * third provider meant touching both. They are registered here instead: a
 * provider is described once, in this file, and selected by id.
 *
 * The registry is pure. It never imports the optional semantic packages
 * eagerly: constructing a provider does not touch the disk or the
 * network, because @huggingface/transformers and @lancedb/lancedb are
 * only imported lazily by the implementations themselves.
 *
 * The registry knows nothing about the vector store: that is a storage
 * concern and lives in src/storage/registry.ts.
 */

import type { EmbeddingProvider } from '../core/ports/embedding.js';
import { type SemanticStackPackage } from '../semantic-stack.js';
import {
  EMBEDDING_DIM,
  EMBEDDING_MODEL_ID,
  TransformersEmbedder,
} from './transformers-embedder.js';

export type { SemanticStackPackage };

// The "which package is missing?" classification belongs to the semantic
// stack itself (src/semantic-stack.ts), because the daemon and the CLI
// need it without pulling in the embedding and storage layers. It is
// re-exported here, where it lived before.
export { missingSemanticPackage } from '../semantic-stack.js';

/** Id of a registered embedding provider. */
export type EmbeddingProviderId = string;

/** Options handed to an embedding provider factory. */
export interface EmbeddingProviderOptions {
  /** Directory where the model files are cached (provider specific). */
  readonly cacheDir?: string | undefined;
}

/** A registered embedding provider. */
export interface EmbeddingProviderRegistration {
  /** Stable id used to select the provider. */
  readonly id: EmbeddingProviderId;
  /** Model identity the provider reports (recorded in worker_state). */
  readonly modelId: string;
  /** Vector dimensionality the provider produces. */
  readonly dimensions: number;
  /** Create a provider instance. */
  readonly create: (options: EmbeddingProviderOptions) => EmbeddingProvider;
}

/** Id of the provider used when no provider is requested explicitly. */
export const DEFAULT_EMBEDDING_PROVIDER_ID = 'transformers';

/** The built-in embedding providers. */
export const EMBEDDING_PROVIDER_REGISTRY: readonly EmbeddingProviderRegistration[] = [
  {
    id: DEFAULT_EMBEDDING_PROVIDER_ID,
    modelId: EMBEDDING_MODEL_ID,
    dimensions: EMBEDDING_DIM,
    create: options => new TransformersEmbedder(options),
  },
];

/** Options for resolveEmbeddingProvider(). */
export interface ResolveEmbeddingProviderOptions {
  /** Id of the provider to use. Defaults to the default provider. */
  readonly providerId?: EmbeddingProviderId | undefined;
  /** Directory where the model files are cached. */
  readonly cacheDir?: string | undefined;
  /** Registry to resolve from. Defaults to the built-in registry. */
  readonly registry?: readonly EmbeddingProviderRegistration[] | undefined;
}

/**
 * Create the embedding provider selected by id.
 * Throws when the id is not registered.
 */
export function resolveEmbeddingProvider(
  options: ResolveEmbeddingProviderOptions = {}
): EmbeddingProvider {
  const registry = options.registry ?? EMBEDDING_PROVIDER_REGISTRY;
  const providerId = options.providerId ?? DEFAULT_EMBEDDING_PROVIDER_ID;
  const registration = registry.find(entry => entry.id === providerId);
  if (registration === undefined) {
    throw new Error(`unknown embedding provider: ${providerId}`);
  }
  return registration.create({ cacheDir: options.cacheDir });
}
