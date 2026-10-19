/**
 * HTTP server bootstrap.
 *
 * Binds the Hono application to a TCP port and turns the "address
 * already in use" failure into a typed error, so the daemon can report
 * a taken port instead of an opaque system error.
 */

import type { Server } from 'node:http';
import { serve, type ServerType } from '@hono/node-server';
import type { Hono } from 'hono';

/** Error thrown when the port is already in use. */
export class PortInUseError extends Error {
  constructor(readonly port: number) {
    super(`port ${port} is already in use`);
    this.name = 'PortInUseError';
  }
}

/** Where the HTTP server binds. */
export interface HttpServerOptions {
  /** The TCP address to bind. */
  readonly host: string;
  /** The TCP port to bind. 0 picks a free port. */
  readonly port: number;
}

/** A bound HTTP server. */
export interface HttpServerHandle {
  /** The underlying node server. */
  readonly server: ServerType;
  /** The port the server actually bound (useful when port 0 was asked). */
  readonly port: number;
  /** Stop accepting connections and end the idle keep-alive ones. */
  close(): Promise<void>;
}

/**
 * Bind the application and wait until the server listens.
 *
 * Rejects with a PortInUseError when the port cannot be bound.
 */
export async function startHttpServer(
  app: Hono,
  options: HttpServerOptions
): Promise<HttpServerHandle> {
  let settlePort!: (port: number) => void;
  let rejectPort!: (error: Error) => void;
  const ready = new Promise<number>((resolve, reject) => {
    settlePort = resolve;
    rejectPort = reject;
  });

  // `overrideGlobalObjects: false` keeps the native global Request/Response:
  // the Hono shim classes break `response instanceof Response` checks inside
  // Transformers.js, which silently disables its model file cache and makes
  // the first model download fail ("Unable to get model file path or buffer").
  const server: ServerType = serve(
    {
      fetch: app.fetch,
      hostname: options.host,
      port: options.port,
      overrideGlobalObjects: false,
    },
    info => settlePort(info.port)
  );
  server.once('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      rejectPort(new PortInUseError(options.port));
    } else {
      rejectPort(error);
    }
  });

  let port: number;
  try {
    port = await ready;
  } catch (error) {
    // Never started listening; ignore the ERR_SERVER_NOT_RUNNING callback error.
    server.close(() => {});
    throw error;
  }

  return {
    server,
    port,
    close: async (): Promise<void> => {
      const nodeServer = server as Server;
      const closePromise = new Promise<void>(resolve => {
        nodeServer.close(() => resolve());
      });
      // End idle keep-alive connections so close() does not hang.
      nodeServer.closeAllConnections?.();
      await closePromise;
    },
  };
}
