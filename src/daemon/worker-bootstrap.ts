/**
 * Worker startup.
 *
 * The indexing worker can be slow to start (the first run downloads the
 * embedding model) and it can fail (offline). It must never take the
 * HTTP server down, so it starts in the background and retries:
 *
 * - success            -> the vector index is marked ready,
 * - missing package    -> the semantic stack is marked as not installed
 *                         and the daemon stays in keyword-only mode
 *                         (permanent: a missing package never appears),
 * - any other failure  -> retried after the configured delay.
 */

import { sleep } from '../core/util/sleep.js';
import { logDaemonError, logDaemonNotice } from '../core/util/log.js';
import { missingSemanticPackage, SEMANTIC_INSTALL_HINT } from '../semantic-stack.js';

/** The part of the indexing worker the daemon drives. */
export interface IndexingWorkerHandle {
  /** Initialize the vector store and the model, then start the polling loop. */
  start(): Promise<void>;
  /** Stop the loop and wait for the current tick to finish. */
  stop(): Promise<void>;
}

/** The readiness flags the daemon controls on the semantic backend. */
export interface SemanticReadiness {
  /** Mark the vector index as usable (or not). */
  setReady(ready: boolean): void;
  /** Mark the semantic stack as missing (permanent for the process). */
  markNotInstalled(): void;
}

/** Options for startWorkerInBackground(). */
export interface WorkerBootstrapOptions {
  /** The worker to start. */
  readonly worker: IndexingWorkerHandle;
  /** The semantic backend to flip; null in keyword-only mode. */
  readonly semantic: SemanticReadiness | null;
  /** Delay before a failed startup is retried. */
  readonly retryDelayMs: number;
  /** True while the daemon is shutting down; aborts the retry loop. */
  readonly isClosing: () => boolean;
}

/**
 * Start the worker in the background and keep retrying until it works,
 * the stack turns out to be missing, or the daemon shuts down.
 *
 * The returned promise resolves when the worker started (or when it gave
 * up); it never rejects, so the daemon can await it during shutdown.
 */
export async function startWorkerInBackground(options: WorkerBootstrapOptions): Promise<void> {
  for (;;) {
    try {
      await options.worker.start();
      if (!options.isClosing()) {
        options.semantic?.setReady(true);
      }
      return;
    } catch (error) {
      // Only a *semantic* package that cannot be resolved is permanent.
      // Every other failure (a user plugin, a transitive dependency, a
      // network problem) is retried: the coarse "some module is missing"
      // check would disable semantic search forever.
      if (missingSemanticPackage(error) !== null) {
        options.semantic?.markNotInstalled();
        logDaemonNotice('the semantic stack is not installed; running in keyword-only mode.');
        logDaemonNotice(SEMANTIC_INSTALL_HINT);
        return;
      }
      logDaemonError('indexing worker failed to start', error);
    }
    const aborted = await sleepOrAborted(options.retryDelayMs, options.isClosing);
    if (aborted) return;
  }
}

/** Sleep that resolves early (true) when the abort check fires. */
async function sleepOrAborted(
  ms: number,
  shouldAbort: () => boolean,
  checkIntervalMs = 100
): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (shouldAbort()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(checkIntervalMs, deadline - Date.now()));
  }
}
