/**
 * The service factory.
 *
 * It assembles the persistence adapters into the ports the services talk
 * to. The instances it returns have to work together: a card written
 * through the card service must be visible to the search service and
 * must show up in the event queue and in the audit trail.
 */

import { describe, expect, it } from 'vitest';
import { createDbContext } from '../../src/db/context.js';
import { createServices } from '../../src/services/context.js';
import { SemanticSearch } from '../../src/services/semantic-search.js';
import {
  cardInput,
  createTestDb,
  FakeEmbedder,
  FakeVectorStore,
  MutableClock,
} from '../test-utils.js';

describe('createServices', () => {
  it('wires the repositories over one database', () => {
    const t = createTestDb();
    try {
      const services = createServices({ repositories: createDbContext(t.db) });
      const created = services.cardService.createCard(
        cardInput({ title: 'docker', body: 'containers' })
      );

      expect(services.cards.getCard(created.id)?.title).toBe('docker');
      expect(services.events.listAll().map(event => event.type)).toEqual(['card.created']);
      expect(services.activity.list(null, 10).entries.map(entry => entry.action)).toEqual([
        'card.created',
      ]);
    } finally {
      t.close();
    }
  });

  it('shares one card repository between the card service and the search', async () => {
    const t = createTestDb();
    try {
      const services = createServices({ repositories: createDbContext(t.db) });
      services.cardService.createCard(cardInput({ title: 'docker deploy', body: 'containers' }));

      const outcome = await services.search.search('docker', 'keyword', 10);
      expect(outcome.modeUsed).toBe('keyword');
      expect(outcome.results.map(result => result.card.id)).toEqual([1]);
      // The search recorded the access through the shared repository.
      expect(services.cards.getCard(1)?.hitCount).toBe(1);
    } finally {
      t.close();
    }
  });

  it('runs keyword-only without a semantic stack', async () => {
    const t = createTestDb();
    try {
      const services = createServices({ repositories: createDbContext(t.db) });
      expect(services.semantic).toBeNull();
      services.cardService.createCard(cardInput({ title: 'docker', body: 'containers' }));
      const outcome = await services.search.search('docker', 'auto', 10);
      expect(outcome.modeUsed).toBe('keyword');
    } finally {
      t.close();
    }
  });

  it('creates the semantic backend when the stack is given', async () => {
    const t = createTestDb();
    try {
      const services = createServices({
        repositories: createDbContext(t.db),
        embedder: new FakeEmbedder(),
        vectors: new FakeVectorStore(),
      });
      const semantic = services.semantic as SemanticSearch | null;
      expect(semantic).not.toBeNull();
      semantic?.setReady(true);

      const outcome = await services.search.search('docker', 'auto', 10);
      expect(outcome.modeUsed).toBe('semantic');
    } finally {
      t.close();
    }
  });

  it('ignores the semantic stack in keyword-only mode', () => {
    const t = createTestDb();
    try {
      const services = createServices({
        repositories: createDbContext(t.db),
        embedder: new FakeEmbedder(),
        vectors: new FakeVectorStore(),
        keywordOnly: true,
      });
      expect(services.semantic).toBeNull();
    } finally {
      t.close();
    }
  });

  it('uses the injected clock', () => {
    const t = createTestDb();
    try {
      const clock = new MutableClock('2024-05-06T07:08:09.000Z');
      const services = createServices({ repositories: createDbContext(t.db, clock) });
      const created = services.cardService.createCard(cardInput({ title: 'docker', body: 'b' }));
      expect(services.cards.getCard(created.id)?.createdAt).toBe('2024-05-06T07:08:09.000Z');
    } finally {
      t.close();
    }
  });
});
