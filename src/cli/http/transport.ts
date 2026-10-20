/**
 * The single HTTP transport primitive of the CLI.
 *
 * Everything the CLI sends to a daemon goes through requestJson, so
 * there is exactly one place that knows about fetch, timeouts, headers
 * and body parsing. The fetch implementation is injectable: a test
 * never has to patch the global.
 */

/** The outcome of one HTTP request. */
export type TransportResult =
  | { kind: 'ok'; status: number; body: unknown }
  | { kind: 'unreachable' };

/** One HTTP request. */
export interface TransportOptions {
  /** The HTTP method, e.g. 'POST'. */
  readonly method: string;
  /** The absolute URL to call. */
  readonly url: string;
  /** The daemon token; sent as X-Memhub-Token when present. */
  readonly token?: string | undefined;
  /** The JSON payload; omitted from the request when undefined. */
  readonly body?: unknown;
  /** How long to wait for the response (default 30s). */
  readonly timeoutMs?: number | undefined;
  /** The fetch implementation to use (default: the global fetch). */
  readonly fetchImpl?: typeof fetch | undefined;
  /**
   * The content type to send. Defaults to application/json when the
   * request carries a body; a bodyless request sends no content type
   * unless one is given explicitly.
   */
  readonly contentType?: string | undefined;
}

/** How long a request may take before it is aborted. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Perform one JSON request.
 *
 * A network failure (including a timeout) surfaces as 'unreachable';
 * an HTTP error response is returned as-is so the caller can print the
 * daemon's {error:{code,message}}. A body that is not JSON is kept as
 * text, an empty body stays an empty string.
 */
export async function requestJson(options: TransportOptions): Promise<TransportResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = {};
  if (options.token !== undefined) {
    headers['x-memhub-token'] = options.token;
  }
  const hasBody = options.body !== undefined;
  const contentType = options.contentType ?? (hasBody ? 'application/json' : undefined);
  if (contentType !== undefined) {
    headers['content-type'] = contentType;
  }
  let response: Response;
  try {
    response = await doFetch(options.url, {
      method: options.method,
      headers,
      body: hasBody ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch {
    return { kind: 'unreachable' };
  }
  const text = await response.text();
  let body: unknown = text;
  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { kind: 'ok', status: response.status, body };
}
