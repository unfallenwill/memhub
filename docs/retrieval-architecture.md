# Retrieval Architecture

## Goals

- Keep writes constant-time: a write is one SQLite transaction, never blocked by embeddings or rules.
- Make every card searchable from the moment it is written.
- Keep SQLite as the single source of truth; every index is a rebuildable derived artifact.

## Module Boundaries

The retrieval path is spread over five layers. The rules that connect
them (the full matrix, the third-party package rules and the acyclicity
requirement) live in [architecture.md](architecture.md) and are enforced
by `scripts/check-layers.mjs`.

- **core** (pure, no dependencies) — the vocabulary of the retrieval path:
  - `src/core/domain/types.ts` — `CardRecord`, `SearchHit`, `SearchMode`, `SEARCH_MODES`.
  - `src/core/ports/search.ts` — `KeywordSearchBackend` and `SemanticSearchBackend`, the two contracts the service talks to. Both forbid recording access: the service records it exactly once for the final, merged result set.
  - `src/core/ports/embedding.ts` — `EmbeddingProvider`.
  - `src/core/ports/vector.ts` — `VectorStore` (and the deprecated `CardVectorStore` alias).
  - `src/core/ports/repositories.ts` — the repository contracts the db adapters implement.
  - `src/core/search/tokenize.ts` — the query tokenizer, the FTS5 quoting and the keyword scoring constants.
  - `src/core/policies/search-merge.ts` — `mergeSearchResults`
    - Merges two hit sets: the primary set wins a conflict on the card id, the secondary set only fills the gaps, the order is never re-sorted and the result is cut off at the limit.
  - `src/core/policies/index-readiness.ts` — decides whether the semantic arm may run.
- **db** (SQLite adapter) —
  - `src/db/keyword-search.ts` — `KeywordSearch` (re-exported by `src/db/search.ts`)
    - FTS5 over title+body, cue matching, and a LIKE fallback over active cards with `indexed_at IS NULL`.
    - `search()` merges FTS + cues + fallback; `searchUnindexed()` exposes only the fallback arm (used by semantic search). Neither records access - the search service does that once for the final result set.
- **services** (application layer, talks to the ports) —
  - `src/services/semantic-search.ts` — `SemanticSearch`
    - Embeds the query, finds the top-k nearest vectors in LanceDB, joins back to SQLite and filters to active cards.
  - `src/services/search-service.ts` — `SearchService`
    - Mode routing (`keyword` / `semantic` / `auto`), merging of semantic hits with the unindexed keyword fallback (through the core merge policy), dedupe by card id, single access recording per result.
- **embedding** and **storage** (the optional backends) —
  - `src/embedding/transformers-embedder.ts` — `TransformersEmbedder`
    - Local ONNX sentence embeddings (`Xenova/all-MiniLM-L6-v2`, mean pooling, L2 normalization) via Transformers.js.
  - `src/storage/vector-index.ts` — `LanceVectorIndex`
    - The `card_vectors` LanceDB table. Writes are delete+insert per `card_id` (idempotent).
- **worker** (the background indexer) —
  - `src/worker/indexer-worker.ts` — `IndexingWorker`
    - Consumes `card.created` / `card.updated` events (plus the `job.*` timer commands), embeds in batches and commits "mark events processed + backfill `indexed_at` + activity log + advance offset" in one transaction.

### Known deviations

There are none. The retrieval path crosses no layer boundary that the
matrix forbids:

- the vector store registry lives in the storage layer
  (`src/storage/registry.ts`), not in the embedding layer,
- the indexing worker logs through `src/core/util/log.ts`, not through
  the runtime layer that sits above it,
- the raw SQLite handle stays inside `src/db/` and `src/runtime/`; the
  worker, the services and the auth layer only ever see ports.

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
