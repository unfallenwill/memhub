/**
 * Open a URL in the system browser (memhub login).
 *
 * Security: the URL is charset-validated before it is ever handed to a
 * shell-adjacent launcher. Windows `cmd /c start` re-parses its command
 * line, so a crafted URL containing &, |, <, >, ^, % or quotes could
 * inject commands; those characters are rejected outright and the URL
 * is only ever passed as a single argv element with shell:false.
 */

import { spawn } from 'node:child_process';

/** Characters that must never appear in an openable URL. */
const FORBIDDEN = /[\s&|<>^%"']/;

/** Whether a URL is safe to pass to the platform launcher. */
export function isOpenableUrl(url: string): boolean {
  if (url === '' || FORBIDDEN.test(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Spawn signature injectable for tests. */
export type SpawnFn = (command: string, args: readonly string[]) => void;

function defaultSpawn(command: string, args: readonly string[]): void {
  const child = spawn(command, [...args], {
    shell: false,
    detached: true,
    stdio: 'ignore',
  });
  // An unhandled 'error' event (e.g. ENOENT when no browser exists)
  // would crash the CLI; a failed launch must degrade to printing.
  child.on('error', () => {});
  child.unref();
}

/**
 * Try to open the URL in the default browser. Returns whether a launch
 * was attempted (the caller falls back to printing the URL).
 */
export function openBrowser(url: string, spawnFn: SpawnFn = defaultSpawn): boolean {
  if (!isOpenableUrl(url)) return false;
  try {
    if (process.platform === 'win32') {
      // Empty "" argument = window title; keeps cmd from eating the URL.
      spawnFn('cmd', ['/c', 'start', '', url]);
    } else if (process.platform === 'darwin') {
      spawnFn('open', [url]);
    } else {
      spawnFn('xdg-open', [url]);
    }
    return true;
  } catch {
    return false;
  }
}
