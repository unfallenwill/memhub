/**
 * Full vector index rebuild.
 *
 * Recreates the LanceDB table from the SQLite source of truth. Used when
 * the embedding model changes (detected at worker startup) and by the
 * `memhub reindex` CLI command.
 */

import type { DatabaseSync } from 'node:sqlite';
import { ActivityLog } from '../db/activity.js';
import { CardStore } from '../db/cards.js';
import { withTransaction } from '../db/database.js';
import { EventStore } from '../db/events.js';
import type { CardRecord } from '../db/types.js';
import { WorkerStateStore } from '../db/worker-state.js';
import type { EmbeddingProvider } from '../embedding/embedder.js';
import type { CardVectorStore } from '../storage/vector-index.js';

/** Outcome of a full rebuild. */
export interface RebuildResult {
  /** Cards successfully embedded and stored. */
  readonly indexed: number;
  /** Cards whose embedding failed (they stay unindexed; the hourly compensation scan retries them). */
  readonly failed: number;
}

/** Dependencies for rebuildVectorIndex. */
export interface RebuildDeps {
  readonly db: DatabaseSync;
  readonly embedder: EmbeddingProvider;
  readonly vectors: CardVectorStore;
  /** Cards embedded per model inference call. */
  readonly embedBatchSize?: number | undefined;
  /** Optional progress callback (invoked after each batch). */
  readonly onProgress?: ((done: number, total: number) => void) | undefined;
}

/** Text fed to the embedding model for a card. */
export function cardEmbeddingText(card: CardRecord): string {
  return `${card.title}\n\n${card.body}`;
}

/**
 * Rebuild the vector index from scratch: drop all vectors, mark every
 * active card unindexed, then re-embed in batches. Cards that fail keep
 * indexed_at = NULL so the compensation scan picks them up later.
 */
export async function rebuildVectorIndex(deps: RebuildDeps): Promise<RebuildResult> {
  const embedBatchSize = deps.embedBatchSize ?? 16;
  const cards = new CardStore(deps.db, {
    events: new EventStore(deps.db),
    activity: new ActivityLog(deps.db),
  });
  const workerState = new WorkerStateStore(deps.db);
  const activity = new ActivityLog(deps.db);

  await deps.vectors.clear();

  const ids = [...cards.listActiveIds()];
  withTransaction(deps.db, () => {
    cards.resetActiveIndexedAt();
    workerState.setModel(deps.embedder.modelId);
  });

  let indexed = 0;
  let failed = 0;
  for (let start = 0; start < ids.length; start += embedBatchSize) {
    const chunkIds = ids.slice(start, start + embedBatchSize);
    const chunk = chunkIds
      .map(id => cards.getCard(id))
      .filter((card): card is CardRecord => card !== null);

    let vectors: readonly number[][] = [];
    let embedFailed = false;
    try {
      vectors = await deps.embedder.embed(chunk.map(cardEmbeddingText));
    } catch {
      embedFailed = true;
    }

    const stored: number[] = [];
    for (let i = 0; i < chunk.length; i++) {
      const card = chunk[i];
      const vector = vectors[i];
      if (embedFailed || vector === undefined) {
        failed++;
        continue;
      }
      try {
        await deps.vectors.upsert(card.id, vector);
        stored.push(card.id);
        indexed++;
      } catch {
        failed++;
      }
    }

    if (stored.length > 0) {
      const indexedAt = new Date().toISOString();
      withTransaction(deps.db, () => {
        cards.setIndexedAt(stored, indexedAt);
        for (const id of stored) {
          activity.append('worker', 'card.indexed', id, {
            model: deps.embedder.modelId,
            via: 'rebuild',
          });
        }
      });
    }
    deps.onProgress?.(Math.min(start + embedBatchSize, ids.length), ids.length);
  }

  return { indexed, failed };
}
