/**
 * The platform launcher of `memhub login` (src/cli/open-browser.ts).
 *
 * The launcher is the one place where the CLI hands a URL to the
 * operating system, so the platform differences (cmd / open / xdg-open)
 * and the default spawn (no shell, detached, error-tolerant) are pinned
 * down here. The default spawn is exercised with a mocked
 * node:child_process so no browser is ever launched on the test machine.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { isOpenableUrl, openBrowser } from '../../src/cli/open-browser.js';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

/** The child handle the mocked spawn returns. */
function fakeChild(): { on: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> } {
  return { on: vi.fn(), unref: vi.fn() };
}

describe('isOpenableUrl', () => {
  it('rejects a URL that the URL parser cannot read', () => {
    // No forbidden character, so the check reaches the parser: 'https://'
    // is a valid scheme with an empty host and makes new URL() throw.
    expect(isOpenableUrl('https://')).toBe(false);
    expect(isOpenableUrl('http://')).toBe(false);
  });

  it('accepts an http(s) URL with a host', () => {
    expect(isOpenableUrl('https://x.example')).toBe(true);
    expect(isOpenableUrl('http://x.example:7800/path')).toBe(true);
  });
});

describe('openBrowser', () => {
  afterEach(() => {
    spawnMock.mockReset();
    vi.restoreAllMocks();
  });

  it('uses cmd /c start on Windows', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const calls: Array<{ command: string; args: readonly string[] }> = [];

    const attempted = openBrowser('https://x.example/login', (command, args) => {
      calls.push({ command, args });
    });

    expect(attempted).toBe(true);
    expect(calls).toEqual([
      { command: 'cmd', args: ['/c', 'start', '', 'https://x.example/login'] },
    ]);
  });

  it('uses open on macOS', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const calls: Array<{ command: string; args: readonly string[] }> = [];

    const attempted = openBrowser('https://x.example/login', (command, args) => {
      calls.push({ command, args });
    });

    expect(attempted).toBe(true);
    expect(calls).toEqual([{ command: 'open', args: ['https://x.example/login'] }]);
  });

  it('uses xdg-open on Linux and everything else', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const calls: Array<{ command: string; args: readonly string[] }> = [];

    const attempted = openBrowser('https://x.example/login', (command, args) => {
      calls.push({ command, args });
    });

    expect(attempted).toBe(true);
    expect(calls).toEqual([{ command: 'xdg-open', args: ['https://x.example/login'] }]);
  });

  it('spawns without a shell, detached and error-tolerant by default', () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

    const attempted = openBrowser('https://x.example/login');

    expect(attempted).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(command).toBe('cmd');
    expect(args).toEqual(['/c', 'start', '', 'https://x.example/login']);
    expect(options.shell).toBe(false);
    expect(options.detached).toBe(true);
    expect(options.stdio).toBe('ignore');
    // A failed launch (ENOENT) must not crash the CLI.
    expect(child.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(child.unref).toHaveBeenCalled();
  });

  it('does not spawn for a URL that cannot be opened', () => {
    spawnMock.mockReturnValue(fakeChild());

    expect(openBrowser('https://x.example/&evil')).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
