/**
 * The background indexing worker and its periodic jobs.
 */

export type { IndexingWorkerDeps } from './indexer-worker.js';
export { IndexingWorker } from './indexer-worker.js';
export type { RebuildDeps, RebuildResult } from './rebuild.js';
export { cardEmbeddingText, rebuildVectorIndex } from './rebuild.js';
export { DAY_MS, RETENTION_DAYS, runRetentionCleanup } from './retention.js';
export type { JobTimersOptions } from './timers.js';
export { JobTimers } from './timers.js';
