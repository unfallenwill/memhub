import { useEffect, useState } from 'preact/hooks';
import { getActivity } from '../api.js';
import { actorClass, formatTime } from '../format.js';

/** Activity stream: activity_log timeline with per-actor styling. */
export default function ActivityView() {
  const [entries, setEntries] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getActivity({ cursor })
      .then(data => {
        if (cancelled) return;
        setEntries(previous =>
          cursor === null ? data.entries ?? [] : [...previous, ...(data.entries ?? [])]
        );
        setNextCursor(data.next_cursor ?? null);
      })
      .catch(err => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cursor]);

  return (
    <section class="view">
      <h1 class="view-title">Activity</h1>
      {error ? <p class="error">{error}</p> : null}
      {entries.length === 0 && !loading ? <p class="empty">No activity yet.</p> : null}
      <ul class="activity-list">
        {entries.map(entry => (
          <li key={entry.id} class={`activity-item actor-${actorClass(entry.actor)}`}>
            <span class={`actor-badge actor-${actorClass(entry.actor)}`}>{entry.actor}</span>
            <span class="activity-action">{entry.action}</span>
            {entry.card_id ? (
              <a class="activity-card" href={`#/cards/${entry.card_id}`}>
                #{entry.card_id}
              </a>
            ) : null}
            <span class="activity-ts">{formatTime(entry.ts)}</span>
          </li>
        ))}
      </ul>
      <div class="pager">
        {nextCursor !== null ? (
          <button type="button" onClick={() => setCursor(nextCursor)} disabled={loading}>
            Load more
          </button>
        ) : null}
        {loading ? <span class="hint">Loading…</span> : null}
      </div>
    </section>
  );
}
