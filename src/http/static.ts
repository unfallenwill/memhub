/**
 * Static hosting for the read-only web UI.
 *
 * The built SPA (web/dist, produced by `pnpm run build:web`) is served by
 * the daemon itself. The API token is injected at serve time: the built
 * index.html contains a `__MEMHUB_TOKEN__` placeholder that is replaced
 * with the real token on every request, so the page can authenticate its
 * /api calls while the token file stays server-side.
 *
 * Static files are exempt from the token check (only the Host header check
 * applies); every /api call made by the page still requires the token.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve, sep } from 'path';
import { getWebDistOverride, WEB_DIST_ENV } from '../config/env.js';
import { notFound } from './errors.js';

/** Placeholder written into web/index.html at build time. */
export const TOKEN_PLACEHOLDER = '__MEMHUB_TOKEN__';

/** Environment variable overriding the web dist directory (used by tests). */
export { WEB_DIST_ENV };

/**
 * Default web dist directory: <repo>/web/dist, resolved relative to this
 * file. The module runs from dist/src/http (compiled daemon) or from
 * src/http (vitest), so both layouts are probed; the compiled layout is
 * the fallback when the web UI has not been built yet.
 */
export function defaultWebDist(): string {
  const override = getWebDistOverride();
  if (override !== null) {
    return resolve(override);
  }
  return resolveWebDist(dirname(fileURLToPath(import.meta.url)), path => existsSync(path));
}

/**
 * Pick web/dist relative to the directory this module lives in.
 * Candidate layouts: compiled (dist/src/http -> repo root) and source
 * (src/http -> repo root). The first candidate with a built index.html
 * wins; otherwise the compiled layout is returned.
 */
export function resolveWebDist(moduleDir: string, exists: (path: string) => boolean): string {
  const candidates = [
    join(moduleDir, '..', '..', '..', 'web', 'dist'), // dist/src/http
    join(moduleDir, '..', '..', 'web', 'dist'), // src/http
  ];
  const fallback = candidates[0] ?? join(moduleDir, 'web', 'dist');
  return candidates.find(candidate => exists(join(candidate, 'index.html'))) ?? fallback;
}

/** A static file ready to be returned as an HTTP response. */
export interface StaticFile {
  readonly body: string | Uint8Array;
  readonly contentType: string;
  readonly cacheControl: string;
  /** Extra security headers for this file (e.g. the CSP on index.html). */
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

/** Content types for the file extensions a Vite build can emit. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

/** Serve static files from a directory (the built web UI). */
export class StaticSite {
  constructor(private readonly root: string) {}

  /** Absolute path of a file inside the root, or null when unsafe/missing. */
  private resolvePath(pathname: string): string | null {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (decoded.includes('\0') || decoded.includes('..')) return null;
    const relative = decoded.replace(/^\/+/, '');
    if (relative === '') return null;
    const absolute = resolve(this.root, relative);
    const rootWithSep = this.root.endsWith(sep) ? this.root : this.root + sep;
    if (!absolute.startsWith(rootWithSep)) return null;
    return absolute;
  }

  /** Read any file inside the dist directory; null when unsafe or missing. */
  file(pathname: string): StaticFile | null {
    const absolute = this.resolvePath(pathname);
    if (absolute === null) return null;
    let isFile: boolean;
    try {
      isFile = statSync(absolute).isFile();
    } catch {
      return null;
    }
    if (!isFile) return null;
    const dot = absolute.lastIndexOf('.');
    const ext = dot === -1 ? '' : absolute.slice(dot).toLowerCase();
    return {
      body: readFileSync(absolute),
      contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream',
      cacheControl: 'public, max-age=3600',
    };
  }

  /**
   * index.html with the token injected. Returns null when the web UI has
   * not been built. Never cached: the HTML embeds the API token.
   *
   * The build writes `window.__MEMHUB_TOKEN__ = "__MEMHUB_TOKEN__";` —
   * only the quoted placeholder value is replaced (the variable name
   * contains the same identifier), with JSON.stringify handling any
   * escaping.
   *
   * The CSP allows the inline token bootstrap script (its content is
   * dynamic, so a hash is impossible) but blocks all remote sources,
   * framing and form submission — the token is the only secret on the
   * page, so keeping exfiltration paths closed matters.
   */
  index(token: string): StaticFile | null {
    const file = this.file('/index.html');
    if (file === null) return null;
    const html = typeof file.body === 'string' ? file.body : new TextDecoder().decode(file.body);
    const quotedPlaceholder = `"${TOKEN_PLACEHOLDER}"`;
    return {
      body: html.split(quotedPlaceholder).join(JSON.stringify(token)),
      contentType: file.contentType,
      cacheControl: 'no-store',
      headers: {
        'content-security-policy':
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; " +
          "base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        'referrer-policy': 'no-referrer',
      },
    };
  }
}

/** Build a Response for a static file. */
export function staticResponse(file: StaticFile): Response {
  return new Response(file.body, {
    headers: {
      'content-type': file.contentType,
      'cache-control': file.cacheControl,
      'x-content-type-options': 'nosniff',
      ...file.headers,
    },
  });
}

/** 404 for a missing static file, using the unified error shape. */
export function staticNotFound(pathname: string): Error {
  return notFound(`no such file: ${pathname}`);
}
