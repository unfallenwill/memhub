import { describe, expect, it } from 'vitest';
import {
  isModuleNotFound,
  semanticInstallHint,
  SEMANTIC_INSTALL_HINT,
  SEMANTIC_PACKAGES,
  type SemanticStackPackage,
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

  it('the install hint keeps its published wording', () => {
    expect(SEMANTIC_INSTALL_HINT).toBe(
      'Semantic search needs the optional packages @huggingface/transformers and ' +
        '@lancedb/lancedb, which are not installed. Install them next to memhub, e.g. ' +
        '`npm install @huggingface/transformers @lancedb/lancedb`, then restart the daemon.'
    );
  });
});

describe('semanticInstallHint', () => {
  it('names only the missing transformers package', () => {
    const hint = semanticInstallHint('@huggingface/transformers');
    expect(hint).toContain('@huggingface/transformers');
    expect(hint).toContain('npm install @huggingface/transformers');
    expect(hint).not.toContain('@lancedb/lancedb');
  });

  it('names only the missing lancedb package', () => {
    const hint = semanticInstallHint('@lancedb/lancedb');
    expect(hint).toContain('@lancedb/lancedb');
    expect(hint).toContain('npm install @lancedb/lancedb');
    expect(hint).not.toContain('@huggingface/transformers');
  });

  it('names every package when the whole stack is missing', () => {
    expect(semanticInstallHint(SEMANTIC_PACKAGES)).toBe(SEMANTIC_INSTALL_HINT);
  });

  it('falls back to the whole stack for an empty list', () => {
    expect(semanticInstallHint([])).toBe(SEMANTIC_INSTALL_HINT);
  });

  it('falls back to the whole stack for an unknown package', () => {
    expect(semanticInstallHint('not-a-semantic-package' as SemanticStackPackage)).toBe(
      SEMANTIC_INSTALL_HINT
    );
  });
});
