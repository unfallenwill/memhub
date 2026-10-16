# Retrieval Architecture

## Goals

- Keep writes constant-time: a write is one SQLite transaction, never blocked by embeddings or rules.
- Make every card searchable from the moment it is written.
- Keep SQLite as the single source of truth; every index is a rebuildable derived artifact.

## Module Boundaries

- `src/db/search.ts` — `KeywordSearch`
  - FTS5 over title+body, cue matching, and a LIKE fallback over active cards with `indexed_at IS NULL`.
  - `search()` merges FTS + cues + fallback and records access; `searchUnindexed()` exposes only the fallback arm (used by semantic search).
- `src/services/semantic-search.ts` — `SemanticSearch`
  - Embeds the query, finds the top-k nearest vectors in LanceDB, joins back to SQLite and filters to active cards.
- `src/services/search-service.ts` — `SearchService`
  - Mode routing (`keyword` / `semantic` / `auto`), merging of semantic hits with the unindexed keyword fallback, dedupe by card id, single access recording per result.
- `src/embedding/transformers-embedder.ts` — `TransformersEmbedder`
  - Local ONNX sentence embeddings (`Xenova/all-MiniLM-L6-v2`, mean pooling, L2 normalization) via Transformers.js.
- `src/storage/vector-index.ts` — `LanceVectorIndex`
  - The `card_vectors` LanceDB table. Writes are delete+insert per `card_id` (idempotent).
- `src/worker/indexer-worker.ts` — `IndexingWorker`
  - Consumes `card.created` / `card.updated` events (plus the `job.*` timer commands), embeds in batches and commits "mark events processed + backfill `indexed_at` + activity log + advance offset" in one transaction.

## Search Flow

1. `POST /api/search` validates the request and hands it to `SearchService`.
2. Mode resolution:
   - `keyword` → FTS5 + cues.
   - `semantic` → vector top-k (503 `index_not_ready` while the model is not loaded).
   - `auto` → semantic when the index is ready, keyword otherwise.
3. Every mode additionally runs the keyword fallback over active cards with `indexed_at IS NULL`, so freshly written cards are findable before the worker reaches them.
4. Results are deduplicated by card id (semantic > keyword precedence), sliced to the limit, and access is recorded once (`hit_count`, `last_accessed_at`).

## Indexing Flow

1. A write inserts the card, a `card.created` event and an activity entry in one transaction and returns `202`.
2. The worker picks up events in id order from the offset stored in `worker_state`.
3. Cards are embedded in batches; vectors are written with an idempotent delete+insert.
4. One commit marks the events processed (failures recorded in `events.error`, never retried automatically), backfills `cards.indexed_at`, appends `card.indexed` activity and advances the offset.
5. Safety nets: an hourly `job.compensation_scan` re-processes any active card still missing `indexed_at`; a changed embedding model (tracked in `worker_state.indexer.model`) drops the vector table and triggers a full rebuild from SQLite; `memhub reindex` does the same on demand.

## Scoring

- Keyword hits: FTS rank weight 1.0, cue match 0.5, fallback 0.25 (best first).
- Semantic hits: `score = 1 - distance / 2` (L2 distance over normalized vectors, i.e. cosine similarity).
- Scores are comparable within a mode but not across modes; the API reports `matched_by` alongside `score`.
