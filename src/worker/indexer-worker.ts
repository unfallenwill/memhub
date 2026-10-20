/**
 * The indexing worker.
 *
 * A single background worker (started with the daemon) consumes the
 * events queue in id order. For every batch it:
 *
 * 1. collects the cards referenced by card.created / card.updated events
 *    (plus any unindexed active cards when a job.compensation_scan event
 *    arrives) and embeds them in batches,
 * 2. writes the vectors to LanceDB with an idempotent delete+insert,
 * 3. commits everything in ONE SQLite transaction: mark the events
 *    processed (with error messages for failures), backfill
 *    cards.indexed_at, append activity_log rows and advance the
 *    worker_state offset.
 *
 * A failing event is recorded in events.error, skipped and never retried
 * automatically; unindexed cards are picked up again by the hourly
 * compensation scan. The offset guarantees at-least-once processing, and
 * the idempotent vector writes make reprocessing harmless.
 */

import type { CardRecord, EventRow } from '../core/domain/types.js';
import { errorMessage } from '../core/util/errors.js';
import { logDaemonError } from '../core/util/log.js';
import { sleep } from '../core/util/sleep.js';
import type { EmbeddingProvider } from '../core/ports/embedding.js';
import type { VectorStore } from '../core/ports/vector.js';
import { cardEmbeddingText, rebuildVectorIndex } from './rebuild.js';
import type { WorkerRepositories } from './repositories.js';
import { runRetentionCleanup } from './retention.js';

/** Dependencies for IndexingWorker. */
export interface IndexingWorkerDeps {
  /**
   * The repositories of the process. The daemon injects the instances of
   * the runtime context, so the worker shares its store graph with the
   * HTTP app and the semantic search.
   */
  readonly repositories: WorkerRepositories;
  readonly embedder: EmbeddingProvider;
  readonly vectors: VectorStore;
  /** Events consumed per tick. */
  readonly batchSize?: number | undefined;
  /** Cards embedded per model inference call. */
  readonly embedBatchSize?: number | undefined;
  /** Idle wait between polls. */
  readonly pollIntervalMs?: number | undefined;
}

/**
 * The event-driven indexing worker. One instance per daemon process.
 */
export class IndexingWorker {
  /** The store graph the worker works on. */
  private readonly repositories: WorkerRepositories;
  private readonly events: WorkerRepositories['events'];
  private readonly cards: WorkerRepositories['cards'];
  private readonly activity: WorkerRepositories['activity'];
  private readonly workerState: WorkerRepositories['workerState'];
  private readonly batchSize: number;
  private readonly embedBatchSize: number;
  private readonly pollIntervalMs: number;

  private stopped = false;
  private startPromise: Promise<void> | null = null;
  private loopPromise: Promise<void> | null = null;

  constructor(private readonly deps: IndexingWorkerDeps) {
    this.repositories = deps.repositories;
    this.events = this.repositories.events;
    this.activity = this.repositories.activity;
    this.cards = this.repositories.cards;
    this.workerState = this.repositories.workerState;
    this.batchSize = deps.batchSize ?? 32;
    this.embedBatchSize = deps.embedBatchSize ?? 16;
    this.pollIntervalMs = deps.pollIntervalMs ?? 250;
  }

  /**
   * Initialize (vector store, embedding model, model-version check) and
   * start the polling loop. Safe to call again after a failure; the
   * initialization is retried, the loop is started at most once.
   */
  async start(): Promise<void> {
    if (this.stopped) return;
    if (this.startPromise === null) {
      this.startPromise = this.initialize().catch(error => {
        this.startPromise = null;
        throw error;
      });
    }
    await this.startPromise;
    if (this.stopped) return;
    if (this.loopPromise === null) {
      this.loopPromise = this.runLoop();
    }
  }

  /** Stop the loop and wait for the current tick to finish. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.startPromise?.catch(() => {});
    await this.loopPromise;
  }

  /**
   * Process one batch of events. Returns the number of events consumed
   * (0 when the queue is empty). Exposed for tests.
   */
  async tick(): Promise<number> {
    const offset = this.workerState.getLastEventId();
    const batch = this.events.listBatchAfter(offset, this.batchSize);
    if (batch.length === 0) return 0;

    // cardId -> error message for cards that failed to index this tick.
    const failures = new Map<number, string>();
    // Cards successfully indexed this tick (indexed_at will be backfilled).
    const indexed = new Map<number, 'event' | 'compensation'>();
    // Cards already handled by the event arm; the compensation scan skips them.
    const touched = new Set<number>();

    // 1. Index cards referenced by domain events.
    const eventCardIds: number[] = [];
    for (const event of batch) {
      if (event.type !== 'card.created' && event.type !== 'card.updated') continue;
      const cardId = parseCardId(event.payload);
      if (cardId !== null && !eventCardIds.includes(cardId)) {
        eventCardIds.push(cardId);
      }
    }
    const toEmbed: CardRecord[] = [];
    for (const cardId of eventCardIds) {
      touched.add(cardId);
      const card = this.cards.getCard(cardId);
      if (card === null) {
        failures.set(cardId, `card ${cardId} not found`);
        continue;
      }
      if (card.status !== 'active') continue; // nothing to index
      if (card.indexedAt !== null) continue; // already indexed (e.g. by a rebuild)
      toEmbed.push(card);
    }
    await this.embedAndStore(toEmbed, failures, indexed, 'event');

    // 2. Job commands.
    let ranRetention = false;
    for (const event of batch) {
      if (event.type === 'job.compensation_scan') {
        const pending = this.cards.listActiveUnindexed().filter(card => !touched.has(card.id));
        await this.embedAndStore(pending, failures, indexed, 'compensation');
      } else if (event.type === 'job.retention_cleanup') {
        ranRetention = true;
      }
    }

    // 3. Commit: events + indexed_at + activity + offset in one transaction.
    const newOffset = batch[batch.length - 1].id;
    const model = this.deps.embedder.modelId;
    this.repositories.transactions.transaction(() => {
      for (const event of batch) {
        this.events.markProcessed(event.id, this.errorFor(event, failures));
      }
      if (indexed.size > 0) {
        const indexedAt = new Date().toISOString();
        this.cards.setIndexedAt([...indexed.keys()], indexedAt);
        for (const [cardId, via] of indexed) {
          this.activity.append('worker', 'card.indexed', cardId, { model, via });
        }
      }
      if (ranRetention) {
        runRetentionCleanup(this.events, newOffset);
      }
      this.workerState.setLastEventId(newOffset);
    });
    return batch.length;
  }

  /** The current worker offset (last consumed event id). */
  get offset(): number {
    return this.workerState.getLastEventId();
  }

  private async embedAndStore(
    cards: readonly CardRecord[],
    failures: Map<number, string>,
    indexed: Map<number, 'event' | 'compensation'>,
    via: 'event' | 'compensation'
  ): Promise<void> {
    for (let start = 0; start < cards.length; start += this.embedBatchSize) {
      const chunk = cards.slice(start, start + this.embedBatchSize);
      let vectors: readonly number[][] = [];
      let embedFailed: unknown = null;
      try {
        vectors = await this.deps.embedder.embed(chunk.map(cardEmbeddingText));
      } catch (error) {
        embedFailed = error;
      }
      for (let i = 0; i < chunk.length; i++) {
        const card = chunk[i];
        const vector = vectors[i];
        if (embedFailed !== null) {
          failures.set(card.id, `embedding failed: ${errorMessage(embedFailed)}`);
          continue;
        }
        if (vector === undefined) {
          failures.set(card.id, 'embedding returned no vector for card');
          continue;
        }
        try {
          await this.deps.vectors.upsert(card.id, vector);
          indexed.set(card.id, via);
        } catch (error) {
          failures.set(card.id, `vector store failed: ${errorMessage(error)}`);
        }
      }
    }
  }

  /** Error message for one event, or null when it was processed cleanly. */
  private errorFor(event: EventRow, failures: Map<number, string>): string | null {
    if (event.type === 'card.created' || event.type === 'card.updated') {
      const cardId = parseCardId(event.payload);
      if (cardId === null) return 'invalid event payload';
      return failures.get(cardId) ?? null;
    }
    if (event.type === 'job.compensation_scan' || event.type === 'job.retention_cleanup') {
      return null;
    }
    return `unknown event type: ${event.type}`;
  }

  private async initialize(): Promise<void> {
    await this.deps.vectors.initialize();
    await this.deps.embedder.ensureLoaded();

    const recorded = this.workerState.getModel();
    if (recorded === this.deps.embedder.modelId) return;

    if (recorded === null) {
      // First run with this database: just record the model.
      this.workerState.setModel(this.deps.embedder.modelId);
      return;
    }
    // Model changed: the vectors are stale. Drop them and rebuild everything.
    await rebuildVectorIndex({
      embedder: this.deps.embedder,
      vectors: this.deps.vectors,
      embedBatchSize: this.embedBatchSize,
      repositories: this.repositories,
    });
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      let processed = 0;
      try {
        processed = await this.tick();
      } catch (error) {
        // Unexpected (e.g. a busy database): log and retry on the next poll.
        logDaemonError('indexing worker tick failed', error);
      }
      if (processed === 0 && !this.stopped) {
        await sleep(this.pollIntervalMs);
      }
    }
  }
}

/** Extract card_id from an event payload, or null when malformed. */
function parseCardId(payload: string): number | null {
  try {
    const parsed = JSON.parse(payload) as { card_id?: unknown };
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.card_id === 'number' &&
      Number.isInteger(parsed.card_id) &&
      parsed.card_id > 0
    ) {
      return parsed.card_id;
    }
    return null;
  } catch {
    return null;
  }
}
