// Thin API client. Every request carries the X-Memhub-Token header with
// the token injected by the daemon into index.html (local daemons) or the
// token stored in localStorage by `memhub login` (remote daemons).

const TOKEN_PLACEHOLDER = '__MEMHUB_TOKEN__';
const LOCAL_STORAGE_KEY = 'memhub.token';

function apiToken() {
  const injected = window.__MEMHUB_TOKEN__;
  if (typeof injected === 'string' && injected !== '' && injected !== TOKEN_PLACEHOLDER) {
    return injected;
  }
  return window.localStorage.getItem(LOCAL_STORAGE_KEY) ?? '';
}

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function isUnauthorized(error) {
  return error instanceof ApiError && error.status === 401;
}

async function request(path, options = {}) {
  const headers = {
    'content-type': 'application/json',
    'x-memhub-token': apiToken(),
    ...(options.headers ?? {}),
  };
  const response = await window.fetch(path, { ...options, headers });
  if (!response.ok) {
    let code = 'http_error';
    let message = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body && typeof body.error === 'object' && body.error !== null) {
        code = body.error.code ?? code;
        message = body.error.message ?? message;
      }
    } catch {
      // non-JSON error body; keep the HTTP-level message
    }
    throw new ApiError(message, response.status, code);
  }
  return response.json();
}

/** List cards with type/status filters and cursor pagination. */
export function getCards({ status, type, cursor, limit } = {}) {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (type) params.set('type', type);
  if (cursor) params.set('cursor', String(cursor));
  if (limit) params.set('limit', String(limit));
  const query = params.toString();
  return request(`/api/cards${query ? `?${query}` : ''}`);
}

/** Fetch a single card. */
export function getCard(id) {
  return request(`/api/cards/${id}`);
}

/** Search cards (auto mode: semantic when the index is ready, else keyword). */
export function searchCards(query, limit = 50) {
  return request('/api/search', {
    method: 'POST',
    body: JSON.stringify({ query, mode: 'auto', limit }),
  });
}

/** Fetch the activity log with cursor pagination. */
export function getActivity({ cursor, limit } = {}) {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', String(cursor));
  if (limit) params.set('limit', String(limit));
  const query = params.toString();
  return request(`/api/activity${query ? `?${query}` : ''}`);
}

/** Daemon health/statistics (no token required). */
export function getHealth() {
  return window.fetch('/healthz').then(response => response.json());
}

/** List devices authorized via memhub login (with the current one flagged). */
export function getDevices() {
  return request('/api/auth/devices');
}

/** Revoke a device token by id. */
export function revokeDevice(id) {
  return request(`/api/auth/devices/${id}`, { method: 'DELETE' });
}
