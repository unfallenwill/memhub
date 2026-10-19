/**
 * In-memory fakes for the service ports.
 *
 * They implement exactly the ports the production adapters implement, so
 * a service test can decide what a backend returns without opening a
 * database. The fakes live in their own file (instead of test-utils.ts)
 * so they never collide with the fixtures of the database layer.
 */

import type {
  ActivityActor,
  ActivityEntry,
  ActivityPage,
  CardRecord,
  CardStats,
  CardStatus,
  CardType,
  CreateCardInput,
  CreateCardResult,
  EventRow,
  QueueStats,
  SearchHit,
  UpdateCardInput,
} from '../../src/core/domain/types.js';
import type {
  ActivityRepository,
  CardPage,
  CardRepository,
  EventRepository,
} from '../../src/core/ports/repositories.js';
import type {
  KeywordSearchBackend,
  SemanticHit,
  SemanticSearchBackend,
} from '../../src/core/ports/search.js';

/** A fixed timestamp for the fake cards. */
export const FAKE_TIMESTAMP = '2024-01-01T00:00:00.000Z';

/** Build a card record with sensible defaults. */
export function fakeCard(overrides: Partial<CardRecord> & { readonly id: number }): CardRecord {
  return {
    id: overrides.id,
    title: overrides.title ?? `card ${overrides.id}`,
    body: overrides.body ?? `body of card ${overrides.id}`,
    type: overrides.type ?? 'fact',
    cues: overrides.cues ?? [],
    confidence: overrides.confidence ?? 0.5,
    writer: overrides.writer ?? null,
    source: overrides.source ?? null,
    status: overrides.status ?? 'active',
    mergedInto: overrides.mergedInto ?? null,
    supersededBy: overrides.supersededBy ?? null,
    createdAt: overrides.createdAt ?? FAKE_TIMESTAMP,
    updatedAt: overrides.updatedAt ?? FAKE_TIMESTAMP,
    indexedAt: overrides.indexedAt ?? null,
    lastAccessedAt: overrides.lastAccessedAt ?? null,
    hitCount: overrides.hitCount ?? 0,
    archivedAt: overrides.archivedAt ?? null,
  };
}

/** Build a keyword search hit for a card. */
export function fakeHit(
  card: CardRecord,
  score = 1,
  matchedBy: SearchHit['matchedBy'] = 'fts'
): SearchHit {
  return { card, score, matchedBy };
}

/** An in-memory card repository. */
export class FakeCardRepository implements CardRepository {
  readonly cards = new Map<number, CardRecord>();
  /** Every recordAccess() call, in order, with the ids it received. */
  readonly accessCalls: number[][] = [];
  private nextId = 1;

  createCard(input: CreateCardInput): CreateCardResult {
    const duplicate = [...this.cards.values()].find(
      card => card.status === 'active' && card.title === input.title && card.body === input.body
    );
    if (duplicate !== undefined) {
      return { id: duplicate.id, indexed: false, deduplicated: true };
    }
    const id = this.nextId++;
    this.cards.set(
      id,
      fakeCard({
        id,
        title: input.title,
        body: input.body,
        type: input.type,
        cues: input.cues,
        confidence: input.confidence,
        writer: input.writer ?? null,
        source: input.source ?? null,
      })
    );
    return { id, indexed: false, deduplicated: false };
  }

  getCard(id: number): CardRecord | null {
    return this.cards.get(id) ?? null;
  }

  listCards(options: {
    status?: CardStatus | undefined;
    type?: CardType | undefined;
    cursor?: number | null;
    limit: number;
  }): CardPage {
    const all = [...this.cards.values()]
      .filter(card => (options.status === undefined ? true : card.status === options.status))
      .filter(card => (options.type === undefined ? true : card.type === options.type))
      .filter(card =>
        options.cursor === undefined || options.cursor === null ? true : card.id < options.cursor
      )
      .sort((a, b) => b.id - a.id);
    const page = all.slice(0, options.limit);
    const hasMore = all.length > options.limit;
    return {
      cards: page,
      nextCursor: hasMore && page.length > 0 ? page[page.length - 1].id : null,
    };
  }

  updateCard(id: number, input: UpdateCardInput): CardRecord | null {
    const current = this.cards.get(id);
    if (current === undefined) return null;
    const updated = fakeCard({
      ...current,
      title: input.title ?? current.title,
      body: input.body ?? current.body,
      type: input.type ?? current.type,
      cues: input.cues ?? current.cues,
      confidence: input.confidence ?? current.confidence,
    });
    this.cards.set(id, updated);
    return updated;
  }

  archiveCard(id: number): CardRecord | null {
    const current = this.cards.get(id);
    if (current === undefined) return null;
    const updated = fakeCard({
      ...current,
      status: 'archived',
      archivedAt: FAKE_TIMESTAMP,
    });
    this.cards.set(id, updated);
    return updated;
  }

  invalidateCard(id: number, supersededBy: number | null): CardRecord | null {
    const current = this.cards.get(id);
    if (current === undefined) return null;
    const updated = fakeCard({
      ...current,
      status: 'superseded',
      supersededBy,
    });
    this.cards.set(id, updated);
    return updated;
  }

  recordAccess(ids: readonly number[]): void {
    this.accessCalls.push([...ids]);
    for (const id of ids) {
      const card = this.cards.get(id);
      if (card === undefined) continue;
      this.cards.set(
        id,
        fakeCard({ ...card, hitCount: card.hitCount + 1, lastAccessedAt: FAKE_TIMESTAMP })
      );
    }
  }

  listActiveUnindexed(): readonly CardRecord[] {
    return [...this.cards.values()]
      .filter(card => card.status === 'active' && card.indexedAt === null)
      .sort((a, b) => a.id - b.id);
  }

  listActiveIds(): readonly number[] {
    return [...this.cards.values()]
      .filter(card => card.status === 'active')
      .map(card => card.id)
      .sort((a, b) => a - b);
  }

  resetActiveIndexedAt(): void {
    for (const [id, card] of this.cards) {
      if (card.status === 'active') this.cards.set(id, fakeCard({ ...card, indexedAt: null }));
    }
  }

  setIndexedAt(ids: readonly number[], indexedAt: string): void {
    for (const id of ids) {
      const card = this.cards.get(id);
      if (card === undefined) continue;
      this.cards.set(id, fakeCard({ ...card, indexedAt }));
    }
  }

  stats(): CardStats {
    const all = [...this.cards.values()];
    const active = all.filter(card => card.status === 'active');
    return {
      total: all.length,
      active: active.length,
      pendingIndex: active.filter(card => card.indexedAt === null).length,
      oldestUnindexedAgeS: 0,
    };
  }
}

/** A keyword backend that returns the hits it was built with. */
export class FakeKeywordSearch implements KeywordSearchBackend {
  /** Every search() call. */
  readonly searchCalls: { query: string; limit: number }[] = [];
  /** Every searchUnindexed() call. */
  readonly unindexedCalls: { query: string; limit: number }[] = [];

  constructor(
    private readonly hits: readonly SearchHit[] = [],
    private readonly unindexedHits: readonly SearchHit[] = []
  ) {}

  search(query: string, limit: number): readonly SearchHit[] {
    this.searchCalls.push({ query, limit });
    return this.hits.slice(0, limit);
  }

  searchUnindexed(query: string, limit: number): readonly SearchHit[] {
    this.unindexedCalls.push({ query, limit });
    return this.unindexedHits.slice(0, limit);
  }
}

/** A semantic backend whose readiness the test controls. */
export class FakeSemanticSearch implements SemanticSearchBackend {
  ready = false;
  notInstalled = false;
  /** Every search() call. */
  readonly calls: { query: string; limit: number }[] = [];

  constructor(private readonly hits: readonly SemanticHit[] = []) {}

  async search(query: string, limit: number): Promise<readonly SemanticHit[]> {
    this.calls.push({ query, limit });
    return this.hits.slice(0, limit);
  }
}

/** An in-memory event queue. */
export class FakeEventRepository implements EventRepository {
  /** Every enqueued event. */
  readonly enqueued: { type: string; payload: unknown }[] = [];

  enqueue(type: string, payload: unknown): void {
    this.enqueued.push({ type, payload });
  }

  stats(): QueueStats {
    return { pendingEvents: this.enqueued.length, oldestPendingEventAgeS: 0 };
  }

  listBatchAfter(offset: number, limit: number): readonly EventRow[] {
    return this.enqueued.slice(offset, offset + limit).map((event, index) => ({
      id: offset + index + 1,
      type: event.type,
      payload: JSON.stringify(event.payload),
      createdAt: FAKE_TIMESTAMP,
      processedAt: null,
      error: null,
    }));
  }

  markProcessed(id: number, error: string | null): void {}

  listAll(): readonly EventRow[] {
    return this.listBatchAfter(0, this.enqueued.length);
  }
}

/** An in-memory audit trail. */
export class FakeActivityRepository implements ActivityRepository {
  /** Every appended entry. */
  readonly entries: {
    actor: ActivityActor;
    action: string;
    cardId: number | null;
    detail: Record<string, unknown> | undefined;
  }[] = [];

  append(
    actor: ActivityActor,
    action: string,
    cardId: number | null,
    detail?: Record<string, unknown> | undefined
  ): void {
    this.entries.push({ actor, action, cardId, detail });
  }

  list(cursor: number | null, limit: number): ActivityPage {
    const all: ActivityEntry[] = this.entries.map((entry, index) => ({
      id: index + 1,
      ts: FAKE_TIMESTAMP,
      actor: entry.actor,
      action: entry.action,
      cardId: entry.cardId,
      detail: entry.detail ?? null,
    }));
    const filtered = cursor === null ? all : all.filter(entry => entry.id < cursor);
    const page = filtered.slice(0, limit);
    const hasMore = filtered.length > limit;
    return {
      entries: page,
      nextCursor: hasMore && page.length > 0 ? page[page.length - 1].id : null,
    };
  }
}
