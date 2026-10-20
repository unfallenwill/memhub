/**
 * The CLI's view of a daemon.
 *
 * A command never builds a URL, a header or a token itself: it asks a
 * DaemonClient. A local daemon and a remote one differ only in the
 * base URL and in how the failure hints read, so both implementations
 * share the transport.
 */

import {
  connectHost,
  postApiJson,
  postShutdown,
  probeHealthz,
  probeHealthzUrl,
  remoteApiFetch,
  type ApiPostResult,
  type HealthProbe,
} from '../client.js';
import type { CommandTarget } from '../target.js';

/** A daemon the CLI can talk to. */
export interface DaemonClient {
  /** How the daemon is named in error hints, e.g. http://127.0.0.1:7800. */
  readonly target: string;
  /** True when the daemon is a remote one (a memhub login target). */
  readonly remote: boolean;
  /** Probe GET /healthz. */
  health(timeoutMs?: number): Promise<HealthProbe>;
  /** POST a JSON payload to an /api route. */
  post(path: string, body: unknown, timeoutMs?: number): Promise<ApiPostResult>;
  /** Ask the daemon to shut down. */
  shutdown(): Promise<boolean>;
}

/** A daemon on this machine, reached over plain HTTP. */
export class LocalDaemonClient implements DaemonClient {
  readonly remote = false;
  readonly target: string;
  private readonly port: number;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(port: number, token: string, fetchImpl?: typeof fetch) {
    this.port = port;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.target = `http://${connectHost()}:${port}`;
  }

  async health(timeoutMs = 2000): Promise<HealthProbe> {
    return probeHealthz(this.port, timeoutMs, this.fetchImpl);
  }

  async post(path: string, body: unknown, timeoutMs = 30_000): Promise<ApiPostResult> {
    return postApiJson(this.port, this.token, path, body, timeoutMs, this.fetchImpl);
  }

  async shutdown(): Promise<boolean> {
    return postShutdown(this.port, this.token, this.fetchImpl);
  }
}

/** A daemon reached over HTTP(S) with the device token of `memhub login`. */
export class RemoteDaemonClient implements DaemonClient {
  readonly remote = true;
  readonly target: string;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(baseUrl: string, token: string, fetchImpl?: typeof fetch) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.target = baseUrl;
  }

  async health(timeoutMs = 5000): Promise<HealthProbe> {
    return probeHealthzUrl(this.baseUrl, timeoutMs, this.fetchImpl);
  }

  async post(path: string, body: unknown, timeoutMs = 30_000): Promise<ApiPostResult> {
    return remoteApiFetch(
      this.baseUrl,
      this.token,
      'POST',
      path,
      body,
      timeoutMs,
      this.fetchImpl ?? fetch
    );
  }

  async shutdown(): Promise<boolean> {
    const result = await remoteApiFetch(
      this.baseUrl,
      this.token,
      'POST',
      '/api/shutdown',
      undefined,
      30_000,
      this.fetchImpl ?? fetch
    );
    return result.kind === 'ok' && result.status >= 200 && result.status < 300;
  }
}

/** A target that points at a real daemon. */
export type ResolvedTarget = Exclude<CommandTarget, { readonly kind: 'error' }>;

/** Build the client for a resolved command target. */
export function createClient(target: ResolvedTarget, fetchImpl?: typeof fetch): DaemonClient {
  if (target.kind === 'remote') {
    return new RemoteDaemonClient(target.baseUrl, target.token, fetchImpl);
  }
  return new LocalDaemonClient(target.port, target.token, fetchImpl);
}
