/**
 * HTTP error type with the unified {error:{code,message}} body shape.
 */

/** An error that maps directly to an HTTP response. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 400 - request body/query failed validation. */
export function invalidRequest(message: string): ApiError {
  return new ApiError(400, 'invalid_request', message);
}

/** 401 - missing or wrong X-Memhub-Token. */
export function unauthorized(): ApiError {
  return new ApiError(401, 'unauthorized', 'Missing or invalid X-Memhub-Token header');
}

/** 403 - Host header is not localhost/127.0.0.1 (DNS rebinding defense). */
export function invalidHost(): ApiError {
  return new ApiError(403, 'invalid_host', 'Requests must target localhost or 127.0.0.1');
}

/** 404 - unknown route or missing resource. */
export function notFound(message = 'Not found'): ApiError {
  return new ApiError(404, 'not_found', message);
}

/** 503 - semantic index not ready yet. */
export function indexNotReady(): ApiError {
  return new ApiError(503, 'index_not_ready', 'The semantic index is not ready yet');
}

/** 404 - the web UI dist directory does not contain index.html. */
export function webUiNotBuilt(): ApiError {
  return new ApiError(
    404,
    'web_ui_not_built',
    'The web UI is not built; run `pnpm run build:web` and restart the daemon'
  );
}
