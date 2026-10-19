/**
 * The wording of the card lifecycle rules.
 *
 * The domain owns the messages: the persistence layer raises them as the
 * message of its error and the transport layer uses them for its answers,
 * so a client always sees the same sentence - no matter which layer
 * detected the problem.
 */

/**
 * The message of an invalid supersede target.
 *
 * A card can only be superseded by a card that exists; the id of the
 * missing successor is part of the message.
 */
export function invalidSupersedeTargetMessage(targetId: number): string {
  return `superseded_by target card ${targetId} does not exist`;
}
