/**
 * Package version resolution.
 *
 * The daemon and CLI report the version from package.json. When running
 * from the compiled output (dist/src/...), package.json lives two levels
 * up; when running sources directly (vitest), it lives one level up.
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

interface PackageJsonLike {
  version?: string;
}

/**
 * Read the package version relative to a base directory.
 * Falls back to "0.0.0" when package.json cannot be found or parsed.
 */
export function readVersion(baseDir: string): string {
  const candidates = [
    join(baseDir, 'package.json'), // sources: <root>/src
    join(baseDir, '..', 'package.json'), // fallback
    join(baseDir, '..', '..', 'package.json'), // dist: <root>/dist/src
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf-8')) as PackageJsonLike;
      if (typeof parsed.version === 'string' && parsed.version !== '') {
        return parsed.version;
      }
    } catch {
      // try the next candidate
    }
  }
  return '0.0.0';
}

/** Get the MemHub package version. */
export function getVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readVersion(here);
}
