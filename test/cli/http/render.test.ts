/**
 * Rendering of daemon failures (src/cli/http/render.ts).
 *
 * The transport layer only knows HTTP; how a failure is explained to the
 * user is a presentation concern. The hints differ between a local daemon
 * and a remote one (memhub login target), so every branch of that
 * decision is pinned down here.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { printApiFailure } from '../../../src/cli/http/render.js';
import type { ApiPostResult } from '../../../src/cli/client.js';

function ok(
  status: number,
  body: unknown = { error: { code: 'boom', message: 'boom' } }
): ApiPostResult {
  return { kind: 'ok', status, body };
}

const UNREACHABLE: ApiPostResult = { kind: 'unreachable' };

describe('printApiFailure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints the daemon error body as one JSON line', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = { error: { code: 'invalid_request', message: 'nope' } };

    printApiFailure(ok(400, body), 'http://127.0.0.1:7800');

    expect(error.mock.calls[0][0]).toBe(JSON.stringify(body));
  });

  it('hints at the local daemon when it cannot be reached', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    printApiFailure(UNREACHABLE, 'http://127.0.0.1:7800');

    const output = error.mock.calls.flat().join('\n');
    expect(output).toContain('Cannot reach the MemHub daemon at http://127.0.0.1:7800');
    expect(output).toContain('memhub server');
  });

  it('hints at the URL when a remote daemon cannot be reached', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    printApiFailure(UNREACHABLE, 'https://memhub.example.com', { remote: true });

    const output = error.mock.calls.flat().join('\n');
    expect(output).toContain('Cannot reach the MemHub daemon at https://memhub.example.com');
    expect(output).toContain('check the URL and whether the server is running');
    expect(output).not.toContain('memhub server');
  });

  it('hints at the local token file on a 401', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    printApiFailure(ok(401), 'http://127.0.0.1:7800');

    const output = error.mock.calls.flat().join('\n');
    expect(output).toContain('the token in ~/.memhub/token');
  });

  it('hints at a fresh login on a 401 against a remote daemon', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    printApiFailure(ok(401), 'https://memhub.example.com', { remote: true });

    const output = error.mock.calls.flat().join('\n');
    expect(output).toContain('the device token for https://memhub.example.com was rejected');
    expect(output).toContain('memhub login --base-url https://memhub.example.com');
  });

  it('hints at the Host header on a 403', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    printApiFailure(ok(403), 'https://memhub.example.com', { remote: true });

    const output = error.mock.calls.flat().join('\n');
    expect(output).toContain('the daemon rejected the Host header');
    expect(output).toContain('MEMHUB_ALLOWED_HOSTS');
  });

  it('prints no hint for other error statuses', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    printApiFailure(ok(500), 'http://127.0.0.1:7800');

    // Only the JSON body, no extra hint.
    expect(error.mock.calls).toHaveLength(1);
  });
});
