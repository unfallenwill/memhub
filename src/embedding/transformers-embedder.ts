/**
 * Transformers.js embedding provider.
 *
 * Runs a small local ONNX sentence embedding model via
 * @huggingface/transformers. The model is downloaded once into the
 * MemHub home (models/ directory) and cached there afterwards - no data
 * ever leaves the machine after the initial download.
 *
 * The library is imported dynamically so that merely constructing the
 * provider (e.g. in tests) never loads the native ONNX runtime; only
 * ensureLoaded()/embed() do.
 */

import type { FeatureExtractionPipeline } from '@huggingface/transformers';
import type { EmbeddingProvider } from './embedder.js';

/** The sentence embedding model used for semantic search. */
export const EMBEDDING_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

/** Dimension of the vectors produced by EMBEDDING_MODEL_ID. */
export const EMBEDDING_DIM = 384;

/** Options for TransformersEmbedder. */
export interface TransformersEmbedderOptions {
  /** Directory where the ONNX model files are cached. */
  readonly cacheDir?: string | undefined;
}

/**
 * Embedding provider backed by Transformers.js.
 * Vectors are mean-pooled and L2-normalized, so cosine similarity maps
 * monotonically to (Euclidean) vector distance.
 */
export class TransformersEmbedder implements EmbeddingProvider {
  readonly modelId = EMBEDDING_MODEL_ID;
  readonly dimensions = EMBEDDING_DIM;

  private extractor: FeatureExtractionPipeline | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(private readonly options: TransformersEmbedderOptions = {}) {}

  async ensureLoaded(): Promise<void> {
    if (this.extractor !== null) return;
    if (this.initPromise === null) {
      this.initPromise = this.load().catch(error => {
        // Allow a later retry instead of caching a rejected promise forever.
        this.initPromise = null;
        throw error;
      });
    }
    await this.initPromise;
  }

  async embed(texts: readonly string[]): Promise<readonly number[][]> {
    if (texts.length === 0) return [];
    await this.ensureLoaded();
    const extractor = this.extractor;
    if (extractor === null) {
      throw new Error('embedding model is not loaded');
    }
    const output = await extractor([...texts], { pooling: 'mean', normalize: true });
    const vectors = output.tolist() as unknown as number[][];
    if (!Array.isArray(vectors) || vectors.length !== texts.length) {
      throw new Error('embedding model returned an unexpected result shape');
    }
    return vectors;
  }

  private async load(): Promise<void> {
    const transformers = await import('@huggingface/transformers');
    if (this.options.cacheDir !== undefined) {
      transformers.env.cacheDir = this.options.cacheDir;
    }
    const extractor = await transformers.pipeline('feature-extraction', this.modelId);
    this.extractor = extractor;
  }
}
