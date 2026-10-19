/**
 * Keyword search (compatibility entry point).
 *
 * The implementation moved to src/db/keyword-search.ts and the tokenizer
 * to the pure core layer (src/core/search/tokenize.ts). This module keeps
 * the historical import paths working:
 *
 * - `KeywordSearch` is re-exported from its new home.
 * - `tokenize` is re-exported from the core layer, so the public API of
 *   the package does not change.
 */

export { KeywordSearch } from './keyword-search.js';
export { tokenize } from '../core/search/tokenize.js';
