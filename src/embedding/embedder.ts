/**
 * Embedding provider contract.
 *
 * The contract now lives in the pure port layer
 * (src/core/ports/embedding.ts); this module stays as a re-export so every
 * existing import point keeps working.
 */

export * from '../core/ports/embedding.js';
