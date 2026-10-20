/**
 * Daemon configuration.
 *
 * Resolves the data directory, the bind address, the port and the web UI
 * directory of a daemon from the explicit options and the environment.
 * The environment is read through the config layer (the only place that
 * touches process.env), never here.
 */

import { getBindHost, getDefaultPort, getMemhubHome } from '../config/paths.js';
import { defaultWebDist } from '../http/static.js';

/** The resolved configuration of a daemon. */
export interface DaemonConfig {
  /** The data directory (token, setup code, database, logs). */
  readonly home: string;
  /** The TCP port to bind. 0 picks a free port. */
  readonly port: number;
  /** The TCP address to bind. */
  readonly host: string;
  /** The built web UI directory; undefined disables the web UI. */
  readonly webDist: string | undefined;
}

/** Options for resolveDaemonConfig(). */
export interface ResolveDaemonConfigOptions {
  /** Data directory. Defaults to the resolved MemHub home. */
  readonly home?: string | undefined;
  /** Port to bind. 0 picks a free port. Defaults to MEMHUB_PORT or 7800. */
  readonly port?: number | undefined;
  /**
   * TCP address to bind. Defaults to the MEMHUB_HOST environment
   * variable, falling back to 127.0.0.1 (loopback only).
   */
  readonly host?: string | undefined;
  /**
   * Directory of the built web UI. Defaults to the web/dist next to the
   * package root (MEMHUB_WEB_DIST overrides). Pass null to disable the
   * web UI entirely.
   */
  readonly webDist?: string | null | undefined;
}

/**
 * Resolve the configuration of a daemon.
 *
 * The default port comes from the environment (MEMHUB_PORT) so a library
 * user that calls the daemon programmatically gets the same port as the
 * CLI - an explicit option always wins over the environment.
 */
export function resolveDaemonConfig(options: ResolveDaemonConfigOptions = {}): DaemonConfig {
  const home = options.home ?? getMemhubHome();
  const port = options.port ?? getDefaultPort();
  const host = options.host ?? getBindHost();
  const webDist = options.webDist === null ? undefined : (options.webDist ?? defaultWebDist());
  return { home, port, host, webDist };
}
