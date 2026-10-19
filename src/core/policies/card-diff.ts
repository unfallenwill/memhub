/**
 * Change detection for card updates.
 *
 * An update may change the searchable content (title, body, cues) or only
 * the metadata (type, confidence). Only a content change invalidates the
 * vector index (`cards.indexed_at` is reset) and enqueues a
 * `card.updated` event.
 *
 * The field order of `changed` is part of the observable behaviour: the
 * list is written verbatim into `activity_log.detail`, so a reordering
 * would change what the audit trail says. The order is
 * title, body, type, cues, confidence.
 *
 * The cue comparison is order-sensitive on purpose: reordering the cues
 * of a card counts as a content change, because the cue list is part of
 * the indexed text.
 */

/** The editable fields of a card, as an update sees them. */
export interface CardDiffInput {
  readonly title: string;
  readonly body: string;
  readonly type: string;
  readonly cues: readonly string[];
  readonly confidence: number;
}

/** What changed between two versions of a card. */
export interface CardDiff {
  /** The names of the changed fields, in the fixed order. */
  readonly changed: readonly string[];
  /** Whether the searchable content changed (the vector index went stale). */
  readonly contentChanged: boolean;
}

/**
 * Compare the stored card with the new values.
 *
 * `current` is the card as it is stored, `next` the card as it would be
 * after the update.
 */
export function diffCard(current: CardDiffInput, next: CardDiffInput): CardDiff {
  const changed: string[] = [];
  if (next.title !== current.title) changed.push('title');
  if (next.body !== current.body) changed.push('body');
  if (next.type !== current.type) changed.push('type');
  if (!cueArraysEqual(next.cues, current.cues)) changed.push('cues');
  if (next.confidence !== current.confidence) changed.push('confidence');

  const contentChanged =
    next.title !== current.title ||
    next.body !== current.body ||
    !cueArraysEqual(next.cues, current.cues);

  return { changed, contentChanged };
}

/** Whether two cue lists are equal, element by element and in order. */
function cueArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((cue, i) => cue === b[i]);
}
