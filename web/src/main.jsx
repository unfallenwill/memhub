import { render } from 'preact';
import App from './app.jsx';
import './styles.css';

// Receive a device-flow token from the login redirect (/#token=...).
// The fragment never reaches the server or the history stack; it is
// consumed immediately and the URL is rewritten in place.
const TOKEN_KEY = 'memhub.token';
const tokenMatch = window.location.hash.match(/^#token=([a-f0-9]+)$/);
if (tokenMatch !== null) {
  window.localStorage.setItem(TOKEN_KEY, tokenMatch[1]);
  window.history.replaceState(null, '', window.location.pathname + window.location.search + '#/');
}

render(<App />, document.getElementById('app'));
