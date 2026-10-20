/**
 * The card store of the SQLite layer (src/db/cards.ts).
 *
 * The store reads the card it is about to change, writes the change and
 * reads the card again. When the second read finds nothing the write
 * is refused instead of reporting a card that is not there any more.
 */

import { describe, expect, it, vi } from 'vitest';
import type { CardStore } from '../../src/db/cards.js';
import { cardInput, createTestDb } from '../test-utils.js';

/** Make every read after the first one come back empty. */
function vanishAfterFirstRead(cards: CardStore): void {
  const real = cards.getCard.bind(cards);
  let reads = 0;
  vi.spyOn(cards, 'getCard').mockImplementation((id: number) => {
    reads += 1;
    return reads === 1 ? real(id) : null;
  });
}

describe('a card that disappears while it is changed', () => {
  it('refuses an update of a card that vanished', () => {
    const t = createTestDb();
    try {
      const card = t.cards.createCard(cardInput({ title: 'One' }));
      vanishAfterFirstRead(t.cards);

      expect(() => t.cards.updateCard(card.id, { title: 'Two' })).toThrow(
        `card ${card.id} disappeared during update`
      );
    } finally {
      t.close();
    }
  });

  it('refuses an archive of a card that vanished', () => {
    const t = createTestDb();
    try {
      const card = t.cards.createCard(cardInput({ title: 'One' }));
      vanishAfterFirstRead(t.cards);

      expect(() => t.cards.archiveCard(card.id)).toThrow(
        `card ${card.id} disappeared during archive`
      );
    } finally {
      t.close();
    }
  });

  it('refuses an invalidation of a card that vanished', () => {
    const t = createTestDb();
    try {
      const card = t.cards.createCard(cardInput({ title: 'One' }));
      vanishAfterFirstRead(t.cards);

      expect(() => t.cards.invalidateCard(card.id, null)).toThrow(
        `card ${card.id} disappeared during invalidate`
      );
    } finally {
      t.close();
    }
  });
});

describe('a card that does not exist', () => {
  it('cannot be invalidated', () => {
    const t = createTestDb();
    try {
      expect(t.cards.invalidateCard(4242, null)).toBeNull();
    } finally {
      t.close();
    }
  });
});
