/**
 * The entry point detection of the CLI (src/cli/entry.ts).
 *
 * npm installs the `memhub` bin as a symlink to the compiled entry
 * script. `process.argv[1]` then holds the symlink while
 * `import.meta.url` always holds the real file, so comparing the two
 * raw strings fails: the command would silently do nothing and exit 0.
 *
 * These tests pin down that the detection compares the *real* paths.
 */

import { mkdtempSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { afterEach, describe, expect, it } from 'vitest';
import { cliEntryPath, isEntryPoint, realPath } from '../../src/cli/entry.js';
import { isCliEntryPoint } from '../../src/cli/index.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The script the `memhub` bin points at. */
const cliEntry = join(repoRoot, 'src', 'cli', 'index.ts');
const cliEntryUrl = pathToFileURL(cliEntry).href;

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'memhub-entry-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * A path that reaches `target` through a symlink.
 *
 * Windows only grants the privilege a *file* symlink needs to some
 * installations, so the fallback links the directory instead - a
 * junction needs no privilege at all. Returns null when the platform
 * refuses both.
 */
function linkTo(target: string, dir: string): string | null {
  const fileLink = join(dir, `file-${basename(target)}`);
  try {
    symlinkSync(target, fileLink, 'file');
    return fileLink;
  } catch {
    // No file symlink on this machine: try the directory below.
  }
  const dirLink = join(dir, 'dir-link');
  try {
    symlinkSync(dirname(target), dirLink, process.platform === 'win32' ? 'junction' : 'dir');
    return join(dirLink, basename(target));
  } catch {
    return null;
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

describe('isEntryPoint', () => {
  it('accepts the module itself', () => {
    expect(isEntryPoint(cliEntry, cliEntryUrl)).toBe(true);
  });

  it('rejects a different file', () => {
    const other = join(tempDir(), 'something-else.js');
    expect(isEntryPoint(other, cliEntryUrl)).toBe(false);
  });

  it('rejects a missing entry path', () => {
    expect(isEntryPoint(undefined, cliEntryUrl)).toBe(false);
  });

  it('rejects a module url that is not a file url', () => {
    expect(isEntryPoint(cliEntry, 'not-a-file-url')).toBe(false);
  });

  it('recognizes the entry point through a symlink', () => {
    const link = linkTo(cliEntry, tempDir());
    if (link === null) {
      throw new Error('this platform supports neither file symlinks nor directory junctions');
    }
    // The naive comparison (resolve(argv[1]) === import.meta.url) fails
    // here - that is exactly the bug the real path comparison fixes.
    expect(resolve(link)).not.toBe(resolve(cliEntry));
    expect(isEntryPoint(link, cliEntryUrl)).toBe(true);
  });
});

describe('the entry point of the CLI module', () => {
  it('recognizes itself when it is started through a symlink', () => {
    const link = linkTo(cliEntry, tempDir());
    if (link === null) {
      throw new Error('this platform supports neither file symlinks nor directory junctions');
    }
    expect(isCliEntryPoint(link)).toBe(true);
  });

  it('does not claim to be the entry point of another process', () => {
    expect(isCliEntryPoint(join(tempDir(), 'other.js'))).toBe(false);
  });
});

describe('realPath', () => {
  it('resolves an existing path to itself', () => {
    expect(realPath(cliEntry)).toBe(realPath(cliEntry));
    expect(realPath(cliEntry)).not.toBe('');
  });

  it('falls back to the lexical form of a path that does not exist', () => {
    const missing = join(tempDir(), 'nope', '..', 'nope.js');
    expect(realPath(missing)).toBe(resolve(missing));
  });
});

describe('cliEntryPath', () => {
  it('returns the real path of the running script', () => {
    const entry = process.argv[1];
    expect(entry).toBeDefined();
    expect(cliEntryPath()).toBe(realPath(entry as string));
  });

  it('throws when the process was not started from a script', () => {
    const original = process.argv[1];
    process.argv[1] = undefined;
    try {
      expect(() => cliEntryPath()).toThrow('cannot determine CLI entry path');
    } finally {
      process.argv[1] = original;
    }
  });
});
