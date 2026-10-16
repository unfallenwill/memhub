import { useEffect, useState } from 'preact/hooks';
import { getCards, searchCards } from '../api.js';
import { CARD_STATUSES, CARD_TYPES, formatTime } from '../format.js';

/**
 * Card list view: search box, type/status filters and cursor pagination.
 * A non-empty search query switches to /api/search results; the filters
 * and pagination apply to the plain listing.
 */
export default function CardsView() {
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [cards, setCards] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (submittedQuery === '') return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    searchCards(submittedQuery)
      .then(data => {
        if (cancelled) return;
        setCards(data.results ?? []);
        setNextCursor(null);
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
  }, [submittedQuery]);

  useEffect(() => {
    if (submittedQuery !== '') return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getCards({ status, type, cursor })
      .then(data => {
        if (cancelled) return;
        setCards(previous => (cursor === null ? data.cards ?? [] : [...previous, ...(data.cards ?? [])]));
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
  }, [submittedQuery, status, type, cursor]);

  function submitSearch(event) {
    event.preventDefault();
    setCursor(null);
    setSubmittedQuery(query.trim());
  }

  function clearSearch() {
    setQuery('');
    setCursor(null);
    setSubmittedQuery('');
  }

  function changeFilter(setter) {
    return event => {
      setCursor(null);
      setter(event.target.value);
    };
  }

  return (
    <section class="view">
      <form class="toolbar" onSubmit={submitSearch}>
        <input
          class="search-input"
          type="search"
          placeholder="Search cards…"
          value={query}
          onInput={event => setQuery(event.target.value)}
          aria-label="Search cards"
        />
        <button type="submit" disabled={loading}>
          Search
        </button>
        {submittedQuery !== '' ? (
          <button type="button" onClick={clearSearch}>
            Clear
          </button>
        ) : null}
        <select value={type} onChange={changeFilter(setType)} aria-label="Filter by type" disabled={submittedQuery !== ''}>
          <option value="">All types</option>
          {CARD_TYPES.map(item => (
            <option value={item}>{item}</option>
          ))}
        </select>
        <select
          value={status}
          onChange={changeFilter(setStatus)}
          aria-label="Filter by status"
          disabled={submittedQuery !== ''}
        >
          <option value="">All statuses</option>
          {CARD_STATUSES.map(item => (
            <option value={item}>{item}</option>
          ))}
        </select>
      </form>

      {error ? <p class="error">{error}</p> : null}
      {submittedQuery !== '' ? (
        <p class="hint">
          Search results for <strong>{submittedQuery}</strong>
        </p>
      ) : null}

      {cards.length === 0 && !loading ? <p class="empty">No cards found.</p> : null}

      <ul class="card-list">
        {cards.map(card => (
          <li key={card.id} class={`card-item status-${card.status}`}>
            <a class="card-title" href={`#/cards/${card.id}`}>
              {card.title}
            </a>
            <div class="card-meta">
              <span class={`badge type-${card.type}`}>{card.type}</span>
              <span class={`badge status-${card.status}`}>{card.status}</span>
              {card.matched_by ? <span class="badge matched">{card.matched_by}</span> : null}
              {card.writer ? <span class="meta-item">by {card.writer}</span> : null}
              <span class="meta-item">{formatTime(card.created_at)}</span>
            </div>
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
