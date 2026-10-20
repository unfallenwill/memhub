/**
 * Merging of two search result sets.
 *
 * The semantic search and the keyword fallback both return hits for the
 * same query; the merged set keeps every card exactly once. The primary
 * set (the semantic hits) wins a conflict, the secondary set (the
 * keyword hits for the cards that are not vector-indexed yet) only fills
 * the gaps.
 *
 * The merge never re-orders: the result is the primary hits in their
 * insertion order, followed by the secondary hits that are new. The
 * caller decides how the order is presented.
 */

import type { SearchHit } from '../domain/types.js';

/**
 * Merge two result sets and cut them off at `limit`.
 *
 * @param primary The hits that win a conflict (in their own order).
 * @param secondary The hits that fill the gaps (in their own order).
 * @param limit The maximum number of hits to return.
 */
export function mergeSearchResults(
  primary: readonly SearchHit[],
  secondary: readonly SearchHit[],
  limit: number
): readonly SearchHit[] {
  const merged = new Map<number, SearchHit>();
  for (const hit of primary) {
    if (!merged.has(hit.card.id)) merged.set(hit.card.id, hit);
  }
  for (const hit of secondary) {
    if (!merged.has(hit.card.id)) merged.set(hit.card.id, hit);
  }
  return [...merged.values()].slice(0, limit);
}
