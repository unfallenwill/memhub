import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMBEDDING_MODEL_ID,
  TransformersEmbedder,
} from '../../src/embedding/transformers-embedder.js';

/**
 * Mock @huggingface/transformers so no native runtime or model is ever
 * loaded in tests. The dynamic import inside TransformersEmbedder picks
 * this mock up.
 */
const mocks = vi.hoisted(() => {
  const state: {
    extract: (texts: string[]) => number[][];
    pipelineCalls: { task: string; model: string }[];
    shouldFail: boolean;
  } = {
    extract: (texts: string[]) => texts.map(text => [text.length, 1, 0]),
    pipelineCalls: [],
    shouldFail: false,
  };
  return {
    state,
    env: { cacheDir: 'default-cache' },
    pipeline: vi.fn(async (task: string, model: string) => {
      state.pipelineCalls.push({ task, model });
      if (state.shouldFail) {
        throw new Error('model download failed');
      }
      return (texts: string[]) => ({
        tolist: () => state.extract(texts),
      });
    }),
  };
});

vi.mock('@huggingface/transformers', () => ({
  env: mocks.env,
  pipeline: mocks.pipeline,
}));

describe('TransformersEmbedder', () => {
  beforeEach(() => {
    mocks.state.pipelineCalls.length = 0;
    mocks.state.shouldFail = false;
    mocks.state.extract = (texts: string[]) => texts.map(text => [text.length, 1, 0]);
    mocks.env.cacheDir = 'default-cache';
    mocks.pipeline.mockClear();
  });

  it('exposes the model id', () => {
    const embedder = new TransformersEmbedder();
    expect(embedder.modelId).toBe(EMBEDDING_MODEL_ID);
    expect(EMBEDDING_MODEL_ID).toBe('Xenova/all-MiniLM-L6-v2');
  });

  it('embeds a batch of texts with one pipeline call', async () => {
    const embedder = new TransformersEmbedder();
    const vectors = await embedder.embed(['hello', 'world!!']);
    expect(vectors).toEqual([
      [5, 1, 0],
      [7, 1, 0],
    ]);
    expect(mocks.pipeline).toHaveBeenCalledTimes(1);
    expect(mocks.state.pipelineCalls[0]).toEqual({
      task: 'feature-extraction',
      model: EMBEDDING_MODEL_ID,
    });
  });

  it('returns an empty array for an empty batch without loading the model', async () => {
    const embedder = new TransformersEmbedder();
    expect(await embedder.embed([])).toEqual([]);
    expect(mocks.pipeline).not.toHaveBeenCalled();
  });

  it('loads the model only once across embed calls', async () => {
    const embedder = new TransformersEmbedder();
    await embedder.embed(['a']);
    await embedder.embed(['b']);
    await embedder.ensureLoaded();
    expect(mocks.pipeline).toHaveBeenCalledTimes(1);
  });

  it('configures the model cache directory', async () => {
    const embedder = new TransformersEmbedder({ cacheDir: '/tmp/memhub-models' });
    await embedder.embed(['a']);
    expect(mocks.env.cacheDir).toBe('/tmp/memhub-models');
  });

  it('rejects when the model cannot be loaded and allows a retry', async () => {
    mocks.state.shouldFail = true;
    const embedder = new TransformersEmbedder();
    await expect(embedder.embed(['a'])).rejects.toThrow('model download failed');

    mocks.state.shouldFail = false;
    const vectors = await embedder.embed(['a']);
    expect(vectors).toEqual([[1, 1, 0]]);
    expect(mocks.pipeline).toHaveBeenCalledTimes(2);
  });

  it('rejects when the model returns an unexpected result shape', async () => {
    mocks.state.extract = () => [[1, 2, 3]]; // wrong length for two inputs
    const embedder = new TransformersEmbedder();
    await expect(embedder.embed(['a', 'b'])).rejects.toThrow('unexpected result shape');
  });
});
