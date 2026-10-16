import { describe, expect, it } from 'vitest';
import {
  isModuleNotFound,
  SEMANTIC_INSTALL_HINT,
  SEMANTIC_PACKAGES,
} from '../src/semantic-stack.js';
import { moduleNotFoundError } from './test-utils.js';

describe('isModuleNotFound', () => {
  it('matches ESM dynamic-import failures', () => {
    expect(isModuleNotFound(moduleNotFoundError('@lancedb/lancedb'))).toBe(true);
  });

  it('matches CJS require failures', () => {
    const error = new Error("Cannot find module '@huggingface/transformers'");
    (error as NodeJS.ErrnoException).code = 'MODULE_NOT_FOUND';
    expect(isModuleNotFound(error)).toBe(true);
  });

  it('falls back to the message when the error has no code', () => {
    expect(isModuleNotFound(new Error("Cannot find package 'x' imported from y"))).toBe(true);
  });

  it('rejects unrelated errors and non-errors', () => {
    expect(isModuleNotFound(new Error('model download failed'))).toBe(false);
    expect(isModuleNotFound(new Error('vector store is not initialized'))).toBe(false);
    expect(isModuleNotFound('Cannot find package x')).toBe(false);
    expect(isModuleNotFound(null)).toBe(false);
  });
});

describe('semantic stack metadata', () => {
  it('lists the packages that make up the stack', () => {
    expect(SEMANTIC_PACKAGES).toEqual(['@huggingface/transformers', '@lancedb/lancedb']);
  });

  it('the install hint contains the install command', () => {
    expect(SEMANTIC_INSTALL_HINT).toContain(
      'npm install @huggingface/transformers @lancedb/lancedb'
    );
  });
});
