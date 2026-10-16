import { useEffect, useState } from 'preact/hooks';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { getCard } from '../api.js';
import { formatTime } from '../format.js';

/** Render markdown body to sanitized HTML (marked + DOMPurify). */
export function renderMarkdown(body) {
  const html = marked.parse(String(body ?? ''), { async: false, gfm: true, breaks: true });
  return DOMPurify.sanitize(html);
}

/** Card detail view: metadata + sanitized markdown preview of the body. */
export default function CardDetail({ id }) {
  const [card, setCard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getCard(id)
      .then(data => {
        if (!cancelled) setCard(data.card ?? null);
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
  }, [id]);

  if (loading) {
    return (
      <section class="view">
        <p class="hint">Loading…</p>
      </section>
    );
  }
  if (error) {
    return (
      <section class="view">
        <p class="error">{error}</p>
        <p>
          <a href="#/">Back to cards</a>
        </p>
      </section>
    );
  }
  if (!card) {
    return (
      <section class="view">
        <p class="error">Card not found.</p>
        <p>
          <a href="#/">Back to cards</a>
        </p>
      </section>
    );
  }

  return (
    <section class="view detail">
      <p class="breadcrumb">
        <a href="#/">Cards</a> / #{card.id}
      </p>
      <h1 class="detail-title">{card.title}</h1>
      <div class="card-meta">
        <span class={`badge type-${card.type}`}>{card.type}</span>
        <span class={`badge status-${card.status}`}>{card.status}</span>
        {card.writer ? <span class="meta-item">writer: {card.writer}</span> : null}
        {card.source ? <span class="meta-item">source: {card.source}</span> : null}
        <span class="meta-item">confidence: {card.confidence}</span>
        <span class="meta-item">hits: {card.hit_count}</span>
        <span class="meta-item">created: {formatTime(card.created_at)}</span>
        <span class="meta-item">updated: {formatTime(card.updated_at)}</span>
        {card.indexed_at ? null : <span class="meta-item">indexing pending</span>}
      </div>
      {card.cues && card.cues.length > 0 ? (
        <p class="cues">
          {card.cues.map(cue => (
            <span class="cue">{cue}</span>
          ))}
        </p>
      ) : null}
      <div class="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(card.body) }} />
    </section>
  );
}
