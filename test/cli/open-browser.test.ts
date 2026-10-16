import { describe, expect, it, vi } from 'vitest';
import { isOpenableUrl, openBrowser } from '../../src/cli/open-browser.js';

describe('open-browser', () => {
  it('accepts plain http(s) URLs', () => {
    expect(isOpenableUrl('https://x.example/login?code=ABCD-1234')).toBe(true);
    expect(isOpenableUrl('http://127.0.0.1:7800/login')).toBe(true);
  });

  it('rejects URLs with shell metacharacters, spaces and bad schemes', () => {
    for (const bad of [
      'https://x.example/&calc',
      'https://x.example/|rm -rf',
      'https://x.example/<script>',
      'https://x.example/%41',
      'https://x.example/ "quoted"',
      'https://x.example/a b',
      'ftp://x.example',
      'not a url',
      '',
    ]) {
      expect(isOpenableUrl(bad), bad).toBe(false);
    }
  });

  it('does not spawn for unopenable URLs', () => {
    const spawnFn = vi.fn();
    expect(openBrowser('https://x.example/&evil', spawnFn)).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('spawns the platform launcher with the URL as one argument', () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const spawnFn = (command: string, args: readonly string[]): void => {
      calls.push({ command, args });
    };
    const url = 'https://x.example/login?code=ABCD-1234';
    const attempted = openBrowser(url, spawnFn);
    expect(attempted).toBe(true);
    expect(calls).toHaveLength(1);
    if (process.platform === 'win32') {
      expect(calls[0].command).toBe('cmd');
      expect(calls[0].args).toEqual(['/c', 'start', '', url]);
    } else if (process.platform === 'darwin') {
      expect(calls[0].command).toBe('open');
    } else {
      expect(calls[0].command).toBe('xdg-open');
    }
    expect(calls[0].args[calls[0].args.length - 1]).toBe(url);
  });

  it('swallows launcher errors and reports failure', () => {
    const spawnFn = (): void => {
      throw new Error('no browser');
    };
    expect(openBrowser('https://x.example', spawnFn)).toBe(false);
  });
});
