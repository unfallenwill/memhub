/**
 * The card use cases.
 *
 * The service expresses business failures as result unions, so the
 * transport layer never has to know the exception types of the
 * persistence layer.
 */

import { describe, expect, it } from 'vitest';
import { CardService } from '../../src/services/card-service.js';
import { cardInput, createTestDb } from '../test-utils.js';
import { FakeActivityRepository, FakeCardRepository, FakeEventRepository } from './fakes.js';

describe('CardService', () => {
  function setup() {
    const cards = new FakeCardRepository();
    const events = new FakeEventRepository();
    const activity = new FakeActivityRepository();
    const service = new CardService({ cards, events, activity });
    return { cards, events, activity, service };
  }

  it('creates a card and reports the deduplication', () => {
    const { service } = setup();
    const created = service.createCard(cardInput({ title: 'docker', body: 'containers' }));
    expect(created.id).toBe(1);
    expect(created.indexed).toBe(false);
    expect(created.deduplicated).toBe(false);
  });

  it('reads a card and reports a missing one', () => {
    const { service } = setup();
    service.createCard(cardInput({ title: 'docker', body: 'containers' }));
    expect(service.getCard(1)?.title).toBe('docker');
    expect(service.getCard(404)).toBeNull();
  });

  it('lists the cards through the repository', () => {
    const { service } = setup();
    service.createCard(cardInput({ title: 'one', body: 'b' }));
    service.createCard(cardInput({ title: 'two', body: 'b' }));
    const page = service.listCards({ limit: 10 });
    expect(page.cards.map(card => card.id)).toEqual([2, 1]);
    expect(page.nextCursor).toBeNull();
  });

  it('updates a card', () => {
    const { service } = setup();
    service.createCard(cardInput({ title: 'docker', body: 'containers' }));
    const outcome = service.updateCard(1, { title: 'docker compose' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected a successful outcome');
    expect(outcome.card.title).toBe('docker compose');
  });

  it('reports a missing card on update', () => {
    const { service } = setup();
    const outcome = service.updateCard(404, { title: 'nope' });
    expect(outcome).toEqual({ ok: false, reason: 'not_found' });
  });

  it('archives a card', () => {
    const { service } = setup();
    service.createCard(cardInput({ title: 'docker', body: 'containers' }));
    const outcome = service.archiveCard(1);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected a successful outcome');
    expect(outcome.card.status).toBe('archived');
  });

  it('reports a missing card on archive', () => {
    const { service } = setup();
    expect(service.archiveCard(404)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('invalidates a card with a successor', () => {
    const { service } = setup();
    service.createCard(cardInput({ title: 'old', body: 'b' }));
    service.createCard(cardInput({ title: 'new', body: 'b' }));
    const outcome = service.invalidateCard(1, 2);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected a successful outcome');
    expect(outcome.card.status).toBe('superseded');
    expect(outcome.card.supersededBy).toBe(2);
  });

  it('invalidates a card without a successor', () => {
    const { service } = setup();
    service.createCard(cardInput({ title: 'old', body: 'b' }));
    const outcome = service.invalidateCard(1, null);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected a successful outcome');
    expect(outcome.card.status).toBe('superseded');
    expect(outcome.card.supersededBy).toBeNull();
  });

  it('reports a missing card on invalidate', () => {
    const { service } = setup();
    expect(service.invalidateCard(404, null)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('reports a missing successor as invalid_target and leaves the card alone', () => {
    const { service, cards } = setup();
    service.createCard(cardInput({ title: 'old', body: 'b' }));
    const outcome = service.invalidateCard(1, 999);
    expect(outcome).toEqual({ ok: false, reason: 'invalid_target', targetId: 999 });
    // The card was not touched.
    expect(cards.getCard(1)?.status).toBe('active');
    expect(cards.getCard(1)?.supersededBy).toBeNull();
  });

  it('exposes the card statistics, the audit trail and the queue state', () => {
    const { service, activity, events } = setup();
    service.createCard(cardInput({ title: 'docker', body: 'containers' }));
    activity.append('hook', 'card.created', 1, { title: 'docker' });
    events.enqueue('card.created', { card_id: 1 });

    expect(service.stats().total).toBe(1);
    expect(service.stats().active).toBe(1);
    expect(service.listActivity(null, 10).entries).toHaveLength(1);
    expect(service.pendingEvents().pendingEvents).toBe(1);
  });
});

describe('CardService on the real repository', () => {
  it('does not let the persistence exception escape', () => {
    const t = createTestDb();
    try {
      const service = new CardService({
        cards: t.cards,
        events: t.events,
        activity: t.activity,
      });
      t.cards.createCard(cardInput({ title: 'old', body: 'b' }));

      // The repository throws InvalidSupersedeTargetError for a missing
      // successor; the service turns it into a result union.
      const outcome = service.invalidateCard(1, 999);
      expect(outcome).toEqual({ ok: false, reason: 'invalid_target', targetId: 999 });
      expect(t.cards.getCard(1)?.status).toBe('active');
    } finally {
      t.close();
    }
  });

  it('invalidates a card through the real repository', () => {
    const t = createTestDb();
    try {
      const service = new CardService({
        cards: t.cards,
        events: t.events,
        activity: t.activity,
      });
      const old = t.cards.createCard(cardInput({ title: 'old', body: 'b' }));
      const next = t.cards.createCard(cardInput({ title: 'new', body: 'b' }));

      const outcome = service.invalidateCard(old.id, next.id);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error('expected a successful outcome');
      expect(outcome.card.status).toBe('superseded');
      expect(outcome.card.supersededBy).toBe(next.id);
    } finally {
      t.close();
    }
  });
});
