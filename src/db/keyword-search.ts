/**
 * Keyword search.
 *
 * M1 retrieval: FTS5 over title+body, cue matching, and a LIKE-based
 * fallback over active cards that have not been vector-indexed yet, so a
 * freshly written card is always searchable. Results are deduplicated by
 * card id and non-active cards are always filtered out.
 *
 * The three arms read the card columns directly instead of loading every
 * matched card one by one: a query used to cost one extra SELECT per
 * candidate row (32 hits = 32 extra round trips).
 *
 * NOTE ON THE PORT CONTRACT: `KeywordSearchBackend` documents that a
 * backend must not record access, because the service records it once for
 * the final, merged result set. This class follows the contract: `search()`
 * only returns hits, the access bookkeeping lives in `SearchService`.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { CardStore } from './cards.js';
import type { KeywordSearchBackend } from '../core/ports/search.js';
import type { CardRecord, MatchedBy, SearchHit } from '../core/domain/types.js';
import { SELECT_COLUMNS, selectCardColumns, toCard, toCues, type CardRow } from './row-mappers.js';
import {
  CUES_SCORE,
  FALLBACK_SCORE,
  FTS_SCORE_WEIGHT,
  quoteFtsToken,
  tokenize,
} from '../core/search/tokenize.js';

/** A card row that also carries the FTS rank of the match. */
interface FtsRow extends CardRow {
  rank: number;
}

/** Search over the card store. */
export class KeywordSearch implements KeywordSearchBackend {
  constructor(
    private readonly db: DatabaseSync,
    /**
     * @deprecated The card store is not used any more: recording the
     * access is the service's job now (see the `KeywordSearchBackend`
     * contract). The parameter is kept so the existing call sites keep
     * working.
     */
    _cards?: CardStore
  ) {}

  /**
   * Run a keyword query and return up to `limit` hits, best first.
   * Does not record access; the caller (SearchService) records it once
   * for the final result set.
   */
  search(query: string, limit: number): readonly SearchHit[] {
    const merged = this.primarySearch(query, limit);

    const hits = [...merged.values()].sort((a, b) => b.score - a.score || b.card.id - a.card.id);
    return hits.slice(0, limit);
  }

  /**
   * Keyword fallback over active cards that are not vector-indexed yet,
   * so a freshly written card is always searchable (also used as the
   * fallback arm of semantic search). Does not record access; callers
   * merge results and record access once.
   */
  searchUnindexed(query: string, limit: number): readonly SearchHit[] {
    const tokens = tokenize(query);
    if (tokens.length === 0 || limit <= 0) return [];
    return this.fallbackSearch(tokens, limit);
  }

  /** FTS5 + cue matching over all active cards, merged and deduplicated. */
  private primarySearch(
    query: string,
    limit: number
  ): Map<number, { card: CardRecord; score: number; matchedBy: MatchedBy }> {
    const tokens = tokenize(query);
    const merged = new Map<number, { card: CardRecord; score: number; matchedBy: MatchedBy }>();
    if (tokens.length === 0) return merged;

    for (const hit of this.ftsSearch(tokens, limit)) {
      merged.set(hit.card.id, hit);
    }
    for (const hit of this.cuesSearch(tokens, limit)) {
      if (!merged.has(hit.card.id)) merged.set(hit.card.id, hit);
    }
    for (const hit of this.fallbackSearch(tokens, limit)) {
      if (!merged.has(hit.card.id)) merged.set(hit.card.id, hit);
    }
    return merged;
  }

  /**
   * FTS5 MATCH over title+body, joined back to active cards.
   *
   * The card columns come out of the join, so the matched cards are
   * mapped without a second query per row.
   */
  private ftsSearch(tokens: readonly string[], limit: number): readonly SearchHit[] {
    const match = tokens.map(quoteFtsToken).join(' ');
    let rows: FtsRow[];
    try {
      rows = this.db
        .prepare(
          `SELECT ${selectCardColumns('c')}, f.rank AS rank
           FROM cards_fts f JOIN cards c ON c.id = f.rowid
           WHERE cards_fts MATCH ? AND c.status = 'active'
           ORDER BY rank LIMIT ?`
        )
        .all(match, limit) as unknown as FtsRow[];
    } catch {
      // Malformed FTS query (should not happen with quoted tokens) - degrade.
      return [];
    }
    return rows.map(row => ({
      card: toCard(row),
      score: FTS_SCORE_WEIGHT * (1 / (1 + Math.abs(row.rank))),
      matchedBy: 'fts' as const,
    }));
  }

  /**
   * Cue matching: any cue contains any query token (case-insensitive).
   *
   * The table is scanned in full (newest id first) until `limit` hits were
   * found - the limit applies to the number of HITS, not to the number of
   * scanned rows, so there is deliberately no SQL LIMIT here.
   */
  private cuesSearch(tokens: readonly string[], limit: number): readonly SearchHit[] {
    const lowered = tokens.map(t => t.toLowerCase());
    const rows = this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM cards WHERE status = 'active' ORDER BY id DESC`)
      .all() as unknown as CardRow[];
    const hits: SearchHit[] = [];
    for (const row of rows) {
      const cues = toCues(row.cues);
      const matched = cues.some(cue => lowered.some(token => cue.toLowerCase().includes(token)));
      if (!matched) continue;
      hits.push({ card: toCard(row), score: CUES_SCORE, matchedBy: 'cues' });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  /**
   * Fallback: LIKE over title/body/cues for active cards that are still
   * waiting for the vector index, so brand-new cards stay findable.
   *
   * Like the cue arm, the scan stops after `limit` hits and not after
   * `limit` scanned rows.
   */
  private fallbackSearch(tokens: readonly string[], limit: number): readonly SearchHit[] {
    const rows = this.db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM cards
         WHERE status = 'active' AND indexed_at IS NULL
         ORDER BY id DESC`
      )
      .all() as unknown as CardRow[];
    const hits: SearchHit[] = [];
    for (const row of rows) {
      const card = toCard(row);
      const haystacks = [
        card.title.toLowerCase(),
        card.body.toLowerCase(),
        ...card.cues.map(c => c.toLowerCase()),
      ];
      // Like FTS: every token must be present somewhere in the card.
      const matched = tokens.every(token => haystacks.some(haystack => haystack.includes(token)));
      if (!matched) continue;
      hits.push({ card, score: FALLBACK_SCORE, matchedBy: 'fallback' });
      if (hits.length >= limit) break;
    }
    return hits;
  }
}
