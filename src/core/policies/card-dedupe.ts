/**
 * Exact-duplicate detection for card writes.
 *
 * v1 has no similarity dedupe, no reinforcement and no decay rules
 * ("mechanism over policy", see AGENTS.md): a write is a duplicate only
 * when the title AND the body match a stored card character for
 * character. The comparison is whitespace- and case-sensitive.
 *
 * The policy is pure, so the store (which finds the candidate) and the
 * service layer (which may reuse an existing card) share one definition.
 */

/** The fields that decide whether two card contents are identical. */
export interface CardContent {
  readonly title: string;
  readonly body: string;
}

/**
 * Whether the two contents are exactly the same.
 *
 * "Same " and "Same" are different cards: the comparison never trims
 * and never folds case.
 */
export function isExactDuplicate(a: CardContent, b: CardContent): boolean {
  return a.title === b.title && a.body === b.body;
}
