/**
 * The stdin path of `memhub add` (src/cli/commands/add.ts).
 *
 * When no --body is given the command drains stdin. The default reader
 * (readStdinAll) is used whenever the caller does not inject one, so
 * this file replaces process.stdin with a fake readable stream to pin
 * the default down without blocking on the real terminal.
 */

import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAddCommand } from '../../../src/cli/commands/add.js';
import type { ApiPostResult } from '../../../src/cli/client.js';
import type { DaemonClient } from '../../../src/cli/http/client.js';

interface FakeStdin extends EventEmitter {
  isTTY?: boolean;
}

/** Install a fake process.stdin; returns the feed/end helpers. */
function useFakeStdin(): { feed: (text: string) => void; end: () => void } {
  const fake = new EventEmitter() as FakeStdin;
  fake.isTTY = false;
  Object.defineProperty(process, 'stdin', {
    value: fake,
    configurable: true,
    writable: true,
  });
  return {
    feed: (text: string): void => {
      fake.emit('data', Buffer.from(text, 'utf-8'));
    },
    end: (): void => {
      fake.emit('end');
    },
  };
}

function fakeClient(): DaemonClient {
  return {
    target: 'http://127.0.0.1:7800',
    remote: false,
    health: async () => ({ kind: 'ok', status: 200, body: {} }),
    post: vi.fn(
      async (): Promise<ApiPostResult> => ({
        kind: 'ok',
        status: 202,
        body: { id: 11 },
      })
    ),
    shutdown: async () => true,
  };
}

describe('the default stdin reader of memhub add', () => {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');

  afterEach(() => {
    if (stdinDescriptor) {
      Object.defineProperty(process, 'stdin', stdinDescriptor);
    } else {
      delete (process as { stdin?: unknown }).stdin;
    }
    vi.restoreAllMocks();
  });

  it('drains stdin into the card body', async () => {
    const stdin = useFakeStdin();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = fakeClient();

    const pending = runAddCommand({
      title: 'T',
      body: null,
      type: 'insight',
      cues: [],
      writer: undefined,
      port: 7800,
      client,
    });

    // The reader is waiting for the stream to end.
    stdin.feed('piped ');
    stdin.feed('body');
    stdin.end();

    expect(await pending).toBe(0);
    expect(client.post).toHaveBeenCalledWith('/api/cards', {
      title: 'T',
      body: 'piped body',
      type: 'insight',
      cues: [],
    });
  });

  it('reports an empty stdin as an empty body', async () => {
    const stdin = useFakeStdin();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = fakeClient();

    const pending = runAddCommand({
      title: 'T',
      body: null,
      type: 'insight',
      cues: [],
      writer: undefined,
      port: 7800,
      client,
    });

    stdin.end();

    expect(await pending).toBe(1);
    expect(error.mock.calls.flat().join('\n')).toContain('empty');
    expect(client.post).not.toHaveBeenCalled();
  });
});
