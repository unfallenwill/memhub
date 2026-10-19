/**
 * The compatibility re-export of the embedding contract.
 *
 * src/embedding/embedder.ts used to hold the contract itself; it now
 * re-exports the pure port (src/core/ports/embedding.js) so every old
 * import point keeps working. The re-export is a runtime statement, so
 * it is only covered when a module actually imports it.
 */

import { describe, expect, it } from 'vitest';
import * as legacy from '../../src/embedding/embedder.js';
import * as port from '../../src/core/ports/embedding.js';

describe('src/embedding/embedder.ts', () => {
  it('is importable and re-exports the port module', () => {
    // The contract is type-only, so the module has no runtime exports;
    // importing it must not throw and must expose the same shape as the
    // port it re-exports.
    expect(legacy).toBeDefined();
    expect(Object.keys(legacy)).toEqual(Object.keys(port));
  });
});
