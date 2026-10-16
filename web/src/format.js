// Small formatting helpers shared by the views.

export const CARD_TYPES = ['fact', 'preference', 'decision', 'insight', 'pattern'];
export const CARD_STATUSES = ['active', 'archived', 'merged', 'rejected', 'superseded'];

/** Render an ISO timestamp as a short local string; '' for null. */
export function formatTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString();
}

/** Actor display label: "user:web" -> "user:web", "hook" -> "hook". */
export function actorClass(actor) {
  return String(actor ?? 'unknown')
    .split(':')[0]
    .replace(/[^a-z0-9-]/gi, '');
}
