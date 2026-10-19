/**
 * The path handling of the static file server (src/http/static.ts).
 *
 * The web UI is served from a directory the daemon owns, so the path
 * resolution has to refuse everything that could escape it: broken
 * percent-encoding, parent directory segments, directories and unknown
 * file types. The content type of an unknown extension falls back to a
 * binary type instead of guessing.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, sep } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveWebDist, StaticSite } from '../../src/http/static.js';

describe('StaticSite path handling', () => {
  let dist: string;

  beforeEach(() => {
    dist = mkdtempSync(join(tmpdir(), 'memhub-static-'));
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><html></html>');
    writeFileSync(join(dist, 'assets', 'app.js'), 'console.log("app");');
    writeFileSync(join(dist, 'README'), 'no extension');
    writeFileSync(join(dist, 'payload.bin'), 'binary');
  });

  afterEach(() => {
    rmSync(dist, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('refuses a path with broken percent-encoding', () => {
    const site = new StaticSite(dist);
    expect(site.file('/%')).toBeNull();
  });

  it('refuses a parent directory segment', () => {
    const site = new StaticSite(dist);
    expect(site.file('/../secret')).toBeNull();
  });

  it('refuses the root itself', () => {
    const site = new StaticSite(dist);
    expect(site.file('/')).toBeNull();
  });

  it('refuses a directory', () => {
    const site = new StaticSite(dist);
    expect(site.file('/assets')).toBeNull();
  });

  it('serves a file from a root that already ends with a separator', () => {
    const site = new StaticSite(dist + sep);
    const file = site.file('/assets/app.js');
    expect(file).not.toBeNull();
    expect(file?.contentType).toBe('text/javascript; charset=utf-8');
  });

  it('falls back to a binary content type for an unknown extension', () => {
    const site = new StaticSite(dist);
    const file = site.file('/payload.bin');
    expect(file?.contentType).toBe('application/octet-stream');
  });

  it('falls back to a binary content type for a file without an extension', () => {
    const site = new StaticSite(dist);
    const file = site.file('/README');
    expect(file?.contentType).toBe('application/octet-stream');
  });

  it('returns null for a file that does not exist', () => {
    const site = new StaticSite(dist);
    expect(site.file('/nope.js')).toBeNull();
  });

  it('refuses a file that resolves outside the root', () => {
    // A relative root is resolved against the working directory, so the
    // resolved path never starts with the root and the file is refused.
    const site = new StaticSite(join('relative', 'web', 'dist'));
    expect(site.file('/index.html')).toBeNull();
  });
});

describe('resolveWebDist', () => {
  it('picks the candidate that has a built index.html', () => {
    const moduleDir = join('C:', 'repo', 'src', 'http');
    const built = join('C:', 'repo', 'web', 'dist');

    const resolved = resolveWebDist(moduleDir, path => path === join(built, 'index.html'));

    expect(resolved).toBe(built);
  });

  it('falls back to the compiled layout when nothing is built', () => {
    const moduleDir = join('C:', 'repo', 'src', 'http');

    const resolved = resolveWebDist(moduleDir, () => false);

    expect(resolved).toBe(join('C:', 'repo', 'src', 'http', '..', '..', '..', 'web', 'dist'));
  });
});
