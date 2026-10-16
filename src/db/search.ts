/**
 * Keyword search.
 *
 * M1 retrieval: FTS5 over title+body, cue matching, and a LIKE-based
 * fallback over active cards that have not been vector-indexed yet, so a
 * freshly written card is always searchable. Results are deduplicated by
 * card id and non-active cards are always filtered out.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { CardStore } from './cards.js';
import type { CardRecord, MatchedBy, SearchHit } from './types.js';

const FTS_SCORE_WEIGHT = 1;
const CUES_SCORE = 0.5;
const FALLBACK_SCORE = 0.25;

/** Search over the card store. */
export class KeywordSearch {
  constructor(
    private readonly db: DatabaseSync,
    private readonly cards: CardStore
  ) {}

  /**
   * Run a keyword query and return up to `limit` hits, best first.
   * Also records access (hit_count + last_accessed_at) for matched cards.
   */
  search(query: string, limit: number): readonly SearchHit[] {
    const merged = this.primarySearch(query, limit);

    const hits = [...merged.values()].sort((a, b) => b.score - a.score || b.card.id - a.card.id);
    const page = hits.slice(0, limit);
    this.cards.recordAccess(page.map(hit => hit.card.id));
    return page;
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

  /** FTS5 MATCH over title+body, joined back to active cards. */
  private ftsSearch(tokens: readonly string[], limit: number): readonly SearchHit[] {
    const match = tokens.map(quoteFtsToken).join(' ');
    let rows: { id: number; rank: number }[];
    try {
      rows = this.db
        .prepare(
          `SELECT c.id AS id, f.rank AS rank
           FROM cards_fts f JOIN cards c ON c.id = f.rowid
           WHERE cards_fts MATCH ? AND c.status = 'active'
           ORDER BY rank LIMIT ?`
        )
        .all(match, limit) as unknown as { id: number; rank: number }[];
    } catch {
      // Malformed FTS query (should not happen with quoted tokens) - degrade.
      return [];
    }
    return rows.flatMap(row => {
      const card = this.cards.getCard(row.id);
      if (!card) return [];
      return [{ card, score: FTS_SCORE_WEIGHT * (1 / (1 + Math.abs(row.rank))), matchedBy: 'fts' }];
    });
  }

  /** Cue matching: any cue contains any query token (case-insensitive). */
  private cuesSearch(tokens: readonly string[], limit: number): readonly SearchHit[] {
    const lowered = tokens.map(t => t.toLowerCase());
    const rows = this.db
      .prepare(`SELECT id, cues FROM cards WHERE status = 'active' ORDER BY id DESC`)
      .all() as unknown as { id: number; cues: string }[];
    const hits: SearchHit[] = [];
    for (const row of rows) {
      let cues: string[] = [];
      try {
        const parsed = JSON.parse(row.cues) as unknown;
        if (Array.isArray(parsed)) {
          cues = parsed.filter((cue): cue is string => typeof cue === 'string');
        }
      } catch {
        continue;
      }
      const matched = cues.some(cue => lowered.some(token => cue.toLowerCase().includes(token)));
      if (!matched) continue;
      const card = this.cards.getCard(row.id);
      if (!card) continue;
      hits.push({ card, score: CUES_SCORE, matchedBy: 'cues' });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  /**
   * Fallback: LIKE over title/body/cues for active cards that are still
   * waiting for the vector index, so brand-new cards stay findable.
   */
  private fallbackSearch(tokens: readonly string[], limit: number): readonly SearchHit[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM cards
         WHERE status = 'active' AND indexed_at IS NULL
         ORDER BY id DESC`
      )
      .all() as unknown as { id: number }[];
    const hits: SearchHit[] = [];
    for (const row of rows) {
      const card = this.cards.getCard(row.id);
      if (!card) continue;
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

/** Split a query into lowercase tokens. */
export function tokenize(query: string): readonly string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length > 0);
}

/** Quote a token as an FTS5 phrase to avoid syntax errors. */
function quoteFtsToken(token: string): string {
  return `"${token.replaceAll('"', '""')}"`;
}
