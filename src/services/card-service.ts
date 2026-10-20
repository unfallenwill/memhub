/**
 * Card use cases.
 *
 * The orchestration layer around the card repository: it owns the rules
 * of the card lifecycle and expresses business failures as result unions
 * instead of letting adapter exceptions travel up into the transport
 * layer.
 *
 * WRITE PATH: the repository performs the card write, the event enqueue
 * and the activity-log append in ONE transaction (that is what the
 * `CardRepository` port promises). The service therefore never writes to
 * the event queue or to the audit trail itself - doing so would duplicate
 * every entry. The event queue and the activity log are part of the
 * service dependencies for the read side: the audit trail and the queue
 * state of the card lifecycle.
 */

import type {
  ActivityPage,
  CardRecord,
  CardStats,
  CardStatus,
  CardType,
  CreateCardInput,
  CreateCardResult,
  QueueStats,
  UpdateCardInput,
} from '../core/domain/types.js';
import type {
  ActivityRepository,
  CardPage,
  CardRepository,
  EventRepository,
} from '../core/ports/repositories.js';

/**
 * The result of a card write.
 *
 * `not_found` is the only business failure a write can have: the card
 * does not exist (or disappeared between the read and the write).
 */
export type CardWriteOutcome =
  | { readonly ok: true; readonly card: CardRecord }
  | { readonly ok: false; readonly reason: 'not_found' };

/**
 * The result of an invalidation.
 *
 * `invalid_target` means the requested successor does not exist; the
 * target id is carried along so the transport layer can build the error
 * message without knowing anything about the persistence layer.
 */
export type CardInvalidateOutcome =
  | { readonly ok: true; readonly card: CardRecord }
  | { readonly ok: false; readonly reason: 'not_found' }
  | { readonly ok: false; readonly reason: 'invalid_target'; readonly targetId: number };

/** Dependencies for CardService. */
export interface CardServiceDeps {
  /** Card data access. */
  readonly cards: CardRepository;
  /** The event queue that drives the asynchronous card work. */
  readonly events: EventRepository;
  /** The audit trail of the card lifecycle. */
  readonly activity: ActivityRepository;
}

/** Options accepted by CardService.listCards(). */
export interface ListCardsOptions {
  readonly status?: CardStatus | undefined;
  readonly type?: CardType | undefined;
  readonly cursor?: number | null;
  readonly limit: number;
}

/** Card use cases on top of the card repository. */
export class CardService {
  constructor(private readonly deps: CardServiceDeps) {}

  /**
   * Create a card.
   *
   * The repository deduplicates exact duplicates (same title and body),
   * so this cannot fail for a business reason; the validation of the
   * input happens at the transport edge.
   */
  createCard(input: CreateCardInput): CreateCardResult {
    return this.deps.cards.createCard(input);
  }

  /** Fetch one card, or null when it does not exist. */
  getCard(id: number): CardRecord | null {
    return this.deps.cards.getCard(id);
  }

  /** List cards (id descending) with optional filters and cursor pagination. */
  listCards(options: ListCardsOptions): CardPage {
    return this.deps.cards.listCards(options);
  }

  /** Update the editable fields of a card. */
  updateCard(id: number, input: UpdateCardInput): CardWriteOutcome {
    const card = this.deps.cards.updateCard(id, input);
    return card === null ? { ok: false, reason: 'not_found' } : { ok: true, card };
  }

  /** Archive a card (soft delete). */
  archiveCard(id: number): CardWriteOutcome {
    const card = this.deps.cards.archiveCard(id);
    return card === null ? { ok: false, reason: 'not_found' } : { ok: true, card };
  }

  /**
   * Invalidate a card: it becomes superseded by `supersededBy`.
   *
   * The successor must exist. The rule is checked here, through the
   * repository port, so the persistence layer never has to throw a
   * domain error at the caller: a missing successor is reported as
   * `invalid_target` and a missing card as `not_found`.
   *
   * The card itself is looked up first: an unknown card is a
   * `not_found`, even when the requested successor is unknown as well.
   */
  invalidateCard(id: number, supersededBy: number | null): CardInvalidateOutcome {
    if (this.deps.cards.getCard(id) === null) {
      return { ok: false, reason: 'not_found' };
    }
    if (supersededBy !== null && this.deps.cards.getCard(supersededBy) === null) {
      return { ok: false, reason: 'invalid_target', targetId: supersededBy };
    }
    const card = this.deps.cards.invalidateCard(id, supersededBy);
    return card === null ? { ok: false, reason: 'not_found' } : { ok: true, card };
  }

  /** Card counts for /healthz and /api/queue. */
  stats(): CardStats {
    return this.deps.cards.stats();
  }

  /** The audit trail of the card lifecycle (newest first). */
  listActivity(cursor: number | null, limit: number): ActivityPage {
    return this.deps.activity.list(cursor, limit);
  }

  /** The state of the event queue that drives the asynchronous card work. */
  pendingEvents(): QueueStats {
    return this.deps.events.stats();
  }
}
