/**
 * The wording of the card lifecycle rules.
 *
 * The message is defined once, in the pure core layer: the persistence
 * layer raises it as the message of its error, the service reports it
 * as a result and the transport layer answers with it.
 */

import { describe, expect, it } from 'vitest';
import { invalidSupersedeTargetMessage } from '../../../src/core/policies/card-lifecycle.js';

describe('invalidSupersedeTargetMessage', () => {
  it('names the missing successor', () => {
    expect(invalidSupersedeTargetMessage(99)).toBe('superseded_by target card 99 does not exist');
  });

  it('is stable for every id', () => {
    expect(invalidSupersedeTargetMessage(1)).toBe('superseded_by target card 1 does not exist');
    expect(invalidSupersedeTargetMessage(0)).toBe('superseded_by target card 0 does not exist');
  });
});
