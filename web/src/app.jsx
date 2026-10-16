import { useEffect, useState } from 'preact/hooks';
import ActivityView from './views/activity.jsx';
import CardDetail from './views/card-detail.jsx';
import CardsView from './views/cards.jsx';

function parseHash() {
  const hash = window.location.hash.replace(/^#/, '') || '/';
  const cardMatch = hash.match(/^\/cards\/(\d+)$/);
  if (cardMatch) {
    return { view: 'card', id: Number(cardMatch[1]) };
  }
  if (hash === '/activity') {
    return { view: 'activity' };
  }
  return { view: 'cards' };
}

/** Top-level shell: header navigation + hash-based routing. */
export default function App() {
  const [route, setRoute] = useState(parseHash);

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return (
    <div class="app">
      <header class="header">
        <a class="brand" href="#/">
          MemHub
        </a>
        <nav class="nav">
          <a href="#/" class={route.view === 'cards' || route.view === 'card' ? 'active' : ''}>
            Cards
          </a>
          <a href="#/activity" class={route.view === 'activity' ? 'active' : ''}>
            Activity
          </a>
        </nav>
      </header>
      <main class="main">
        {route.view === 'cards' ? <CardsView /> : null}
        {route.view === 'card' ? <CardDetail id={route.id} /> : null}
        {route.view === 'activity' ? <ActivityView /> : null}
      </main>
    </div>
  );
}
