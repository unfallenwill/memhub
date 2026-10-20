/**
 * Query tokenization and the scoring constants of the keyword backend.
 *
 * The tokenizer splits a query into the lowercase words the FTS5 index
 * and the LIKE fallback work with. The constants are the weights of the
 * three keyword arms (FTS5, cues, unindexed fallback); they live next to
 * the tokenizer because both describe how a query is turned into
 * matches.
 */

/** Split a query into lowercase tokens. */
export function tokenize(query: string): readonly string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length > 0);
}

/** Quote a token as an FTS5 phrase to avoid syntax errors. */
export function quoteFtsToken(token: string): string {
  return `"${token.replaceAll('"', '""')}"`;
}

/** Weight of the FTS5 arm. */
export const FTS_SCORE_WEIGHT = 1;

/** Score of a cue match. */
export const CUES_SCORE = 0.5;

/** Score of the LIKE fallback over the not-yet-indexed cards. */
export const FALLBACK_SCORE = 0.25;
