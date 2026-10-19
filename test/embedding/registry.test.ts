import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EMBEDDING_PROVIDER_ID,
  EMBEDDING_PROVIDER_REGISTRY,
  missingSemanticPackage,
  resolveEmbeddingProvider,
  type EmbeddingProviderRegistration,
} from '../../src/embedding/registry.js';
import {
  EMBEDDING_DIM,
  EMBEDDING_MODEL_ID,
  TransformersEmbedder,
} from '../../src/embedding/transformers-embedder.js';
import { FakeEmbedder, moduleNotFoundError } from '../test-utils.js';

describe('resolveEmbeddingProvider', () => {
  it('creates the default provider when no provider is requested', () => {
    const provider = resolveEmbeddingProvider();
    expect(provider).toBeInstanceOf(TransformersEmbedder);
    expect(provider.modelId).toBe(EMBEDDING_MODEL_ID);
    expect(provider.dimensions).toBe(EMBEDDING_DIM);
  });

  it('selects the provider by id', () => {
    const provider = resolveEmbeddingProvider({ providerId: DEFAULT_EMBEDDING_PROVIDER_ID });
    expect(provider.modelId).toBe(EMBEDDING_MODEL_ID);
  });

  it('registers the built-in provider with matching metadata', () => {
    const registration = EMBEDDING_PROVIDER_REGISTRY.find(
      entry => entry.id === DEFAULT_EMBEDDING_PROVIDER_ID
    );
    expect(registration).toBeDefined();
    const provider = registration?.create({});
    expect(provider?.modelId).toBe(registration?.modelId);
    expect(provider?.dimensions).toBe(registration?.dimensions);
  });

  it('rejects an unregistered provider id', () => {
    expect(() => resolveEmbeddingProvider({ providerId: 'does-not-exist' })).toThrow(
      'unknown embedding provider: does-not-exist'
    );
  });

  it('uses a custom registry instead of the built-in one', () => {
    const fake: EmbeddingProviderRegistration = {
      id: 'fake',
      modelId: 'fake-model',
      dimensions: 8,
      create: () => new FakeEmbedder({ modelId: 'fake-model' }),
    };
    const provider = resolveEmbeddingProvider({ providerId: 'fake', registry: [fake] });
    expect(provider.modelId).toBe('fake-model');
    expect(provider.dimensions).toBe(8);
  });

  it('does not find the default provider in a registry that omits it', () => {
    expect(() => resolveEmbeddingProvider({ registry: [] })).toThrow(
      'unknown embedding provider: transformers'
    );
  });

  it('passes the cache directory to the provider factory', () => {
    const seen: (string | undefined)[] = [];
    const registration: EmbeddingProviderRegistration = {
      id: 'probe',
      modelId: 'probe-model',
      dimensions: 2,
      create: options => {
        seen.push(options.cacheDir);
        return new FakeEmbedder();
      },
    };
    resolveEmbeddingProvider({
      providerId: 'probe',
      cacheDir: '/tmp/models',
      registry: [registration],
    });
    expect(seen).toEqual(['/tmp/models']);
  });
});

describe('missingSemanticPackage', () => {
  it('detects a missing transformers package', () => {
    expect(missingSemanticPackage(moduleNotFoundError('@huggingface/transformers'))).toBe(
      '@huggingface/transformers'
    );
  });

  it('detects a missing lancedb package', () => {
    expect(missingSemanticPackage(moduleNotFoundError('@lancedb/lancedb'))).toBe(
      '@lancedb/lancedb'
    );
  });

  it('detects a CommonJS style failure', () => {
    const error = new Error("Cannot find module '@lancedb/lancedb'");
    (error as NodeJS.ErrnoException).code = 'MODULE_NOT_FOUND';
    expect(missingSemanticPackage(error)).toBe('@lancedb/lancedb');
  });

  it('detects a missing package named in error.url', () => {
    const error = new Error('module resolution failed');
    (error as NodeJS.ErrnoException).code = 'ERR_MODULE_NOT_FOUND';
    (error as { url?: unknown }).url = '@huggingface/transformers';
    expect(missingSemanticPackage(error)).toBe('@huggingface/transformers');
  });

  it('detects a missing package through a subpath specifier', () => {
    expect(missingSemanticPackage(moduleNotFoundError('@lancedb/lancedb/dist/index.js'))).toBe(
      '@lancedb/lancedb'
    );
  });

  it('ignores a missing package that is not part of the semantic stack', () => {
    expect(missingSemanticPackage(moduleNotFoundError('some-user-plugin'))).toBeNull();
  });

  it('ignores a failure of a plugin that merely imports the semantic stack', () => {
    const error = new Error(
      "Cannot find package 'broken-plugin' imported from /app/node_modules/@lancedb/lancedb/index.js"
    );
    (error as NodeJS.ErrnoException).code = 'ERR_MODULE_NOT_FOUND';
    expect(missingSemanticPackage(error)).toBeNull();
  });

  it('ignores errors that are not module resolution failures', () => {
    expect(missingSemanticPackage(new Error('model download failed'))).toBeNull();
    expect(missingSemanticPackage(new Error('vector store is not initialized'))).toBeNull();
  });

  it('ignores non-errors', () => {
    expect(missingSemanticPackage('Cannot find package @lancedb/lancedb')).toBeNull();
    expect(missingSemanticPackage(null)).toBeNull();
    expect(missingSemanticPackage(undefined)).toBeNull();
  });

  it('ignores a file path that is not a package specifier', () => {
    const error = new Error("Cannot find module '/app/dist/src/worker/index.js'");
    (error as NodeJS.ErrnoException).code = 'ERR_MODULE_NOT_FOUND';
    expect(missingSemanticPackage(error)).toBeNull();
  });
});
