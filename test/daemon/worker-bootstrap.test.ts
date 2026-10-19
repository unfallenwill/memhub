/**
 * The startup of the indexing worker (src/daemon/worker-bootstrap.ts).
 *
 * The worker runs in the background: a failure must never take the HTTP
 * server down. Only a *semantic* package that cannot be resolved is
 * permanent - the daemon then stays in keyword-only mode and stops
 * retrying. Every other failure is retried, because it may be a
 * temporary one (a network hiccup, a locked file) or a problem that
 * has nothing to do with the semantic stack at all.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  startWorkerInBackground,
  type IndexingWorkerHandle,
  type SemanticReadiness,
} from '../../src/daemon/worker-bootstrap.js';
import { moduleNotFoundError } from '../test-utils.js';

/** A semantic backend that records what the daemon did with it. */
function fakeSemantic(): SemanticReadiness & {
  readonly ready: boolean[];
  readonly notInstalled: boolean[];
} {
  const ready: boolean[] = [];
  const notInstalled: boolean[] = [];
  return {
    ready,
    notInstalled,
    setReady(value: boolean): void {
      ready.push(value);
    },
    markNotInstalled(): void {
      notInstalled.push(true);
    },
  };
}

/** A worker that fails with the given errors and then succeeds. */
function failingWorker(errors: readonly unknown[]): IndexingWorkerHandle & { attempts: number } {
  let attempts = 0;
  return {
    get attempts(): number {
      return attempts;
    },
    async start(): Promise<void> {
      const error = errors[attempts];
      attempts += 1;
      if (error !== undefined) throw error;
    },
    async stop(): Promise<void> {},
  };
}

describe('startWorkerInBackground', () => {
  it('marks the semantic backend as ready when the worker starts', async () => {
    const semantic = fakeSemantic();
    const worker = failingWorker([]);

    await startWorkerInBackground({
      worker,
      semantic,
      retryDelayMs: 1,
      isClosing: () => false,
    });

    expect(semantic.ready).toEqual([true]);
    expect(semantic.notInstalled).toEqual([]);
  });

  it('gives up when a semantic package is missing', async () => {
    const semantic = fakeSemantic();
    const worker = failingWorker([moduleNotFoundError('@huggingface/transformers')]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await startWorkerInBackground({
        worker,
        semantic,
        retryDelayMs: 1,
        isClosing: () => false,
      });

      expect(semantic.notInstalled).toEqual([true]);
      expect(semantic.ready).toEqual([]);
      expect(worker.attempts).toBe(1);
    } finally {
      error.mockRestore();
    }
  });

  it('keeps retrying when a module that is not part of the semantic stack is missing', async () => {
    const semantic = fakeSemantic();
    // A user plugin (or a transitive dependency) that cannot be resolved
    // is not a missing semantic stack: the daemon must not disable
    // semantic search because of it.
    const worker = failingWorker([
      moduleNotFoundError('some-user-plugin'),
      moduleNotFoundError('another-plugin'),
    ]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await startWorkerInBackground({
        worker,
        semantic,
        retryDelayMs: 1,
        isClosing: () => false,
      });

      expect(semantic.notInstalled).toEqual([]);
      expect(semantic.ready).toEqual([true]);
      expect(worker.attempts).toBe(3);
    } finally {
      error.mockRestore();
    }
  });

  it('stops the retry loop when the daemon is closing', async () => {
    const semantic = fakeSemantic();
    const worker = failingWorker([new Error('offline'), new Error('offline')]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await startWorkerInBackground({
        worker,
        semantic,
        retryDelayMs: 50,
        isClosing: () => true,
      });

      expect(semantic.notInstalled).toEqual([]);
      expect(semantic.ready).toEqual([]);
      expect(worker.attempts).toBe(1);
    } finally {
      error.mockRestore();
    }
  });
});
