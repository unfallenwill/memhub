/**
 * Daemon bootstrap.
 *
 * Opens the database, creates/loads the token, builds the Hono app and
 * serves it on the loopback interface by default (MEMHUB_HOST overrides,
 * e.g. 0.0.0.0 in containers). Alongside the HTTP server it starts:
 *
 * - the indexing worker (embedding model + LanceDB vector index), which
 *   also powers semantic search once it is ready, and
 * - the periodic job timers (hourly compensation scan, daily retention
 *   cleanup) that only enqueue events for the worker.
 *
 * All of it shuts down gracefully via POST /api/shutdown.
 */

import { mkdirSync } from 'fs';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { serve, type ServerType } from '@hono/node-server';
import { ActivityLog } from '../db/activity.js';
import { CardStore } from '../db/cards.js';
import { openDatabase } from '../db/database.js';
import { EventStore } from '../db/events.js';
import type { EmbeddingProvider } from '../embedding/embedder.js';
import { TransformersEmbedder } from '../embedding/transformers-embedder.js';
import { createApp } from '../http/app.js';
import { defaultWebDist } from '../http/static.js';
import {
  DEFAULT_PORT,
  getAllowedHosts,
  getBindHost,
  getDatabasePath,
  getLanceDbPath,
  getMemhubHome,
  getModelsDir,
  getTokenPath,
} from '../paths.js';
import { isModuleNotFound, SEMANTIC_INSTALL_HINT } from '../semantic-stack.js';
import { SemanticSearch } from '../services/semantic-search.js';
import type { CardVectorStore } from '../storage/vector-index.js';
import { LanceVectorIndex } from '../storage/vector-index.js';
import { getVersion } from '../version.js';
import { IndexingWorker } from '../worker/indexer-worker.js';
import { JobTimers } from '../worker/timers.js';
import { resolveToken } from './token.js';

/** Error thrown when the port is already in use. */
export class PortInUseError extends Error {
  constructor(readonly port: number) {
    super(`port ${port} is already in use`);
    this.name = 'PortInUseError';
  }
}

/** A running MemHub daemon. */
export interface DaemonHandle {
  /** The address the server bound (useful for logging). */
  readonly host: string;
  /** The actual bound port (useful when port 0 was requested). */
  readonly port: number;
  readonly pid: number;
  /** Resolves once the daemon has been closed. */
  readonly closed: Promise<void>;
  /** Gracefully stop the daemon and resolve `closed`. */
  close(): Promise<void>;
}

/**
 * Indexing infrastructure injected into the daemon. Tests pass fakes;
 * production uses createDefaultWorkerContext (Transformers.js + LanceDB).
 */
export interface DaemonWorkerOptions {
  readonly embedder: EmbeddingProvider;
  readonly vectors: CardVectorStore;
  /** Retry delay after a failed worker startup (default: 60s). */
  readonly retryDelayMs?: number | undefined;
}

/** Options for startDaemon. */
export interface DaemonOptions {
  /** Data directory. Defaults to the resolved MemHub home. */
  readonly home?: string | undefined;
  /** Port to bind. 0 picks a free port. Defaults to 7800. */
  readonly port?: number | undefined;
  /**
   * TCP address to bind. Defaults to the MEMHUB_HOST environment
   * variable, falling back to 127.0.0.1 (loopback only).
   */
  readonly host?: string | undefined;
  /**
   * Directory of the built web UI to serve at GET /. Defaults to the
   * web/dist next to the package root (MEMHUB_WEB_DIST overrides).
   * Pass null to disable the web UI entirely.
   */
  readonly webDist?: string | null | undefined;
  /**
   * Embedding/vector plumbing for the worker. Defaults to the real
   * Transformers.js embedder and a LanceDB store under the MemHub home.
   */
  readonly worker?: DaemonWorkerOptions | undefined;
}

/** How often a failed worker startup (e.g. model download) is retried. */
export const WORKER_START_RETRY_MS = 60_000;

/** Build the production worker context (no I/O happens at construction). */
export function createDefaultWorkerContext(home: string): DaemonWorkerOptions {
  return {
    embedder: new TransformersEmbedder({ cacheDir: getModelsDir(home) }),
    vectors: new LanceVectorIndex(getLanceDbPath(home)),
  };
}

/**
 * Start the MemHub daemon in the current process.
 * Rejects with PortInUseError when the port cannot be bound.
 */
export async function startDaemon(options: DaemonOptions = {}): Promise<DaemonHandle> {
  const home = options.home ?? getMemhubHome();
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? getBindHost();
  mkdirSync(home, { recursive: true });

  const token = resolveToken(getTokenPath(home));
  const db = openDatabase(getDatabasePath(home));
  const workerOptions = options.worker ?? createDefaultWorkerContext(home);
  const retryDelayMs = workerOptions.retryDelayMs ?? WORKER_START_RETRY_MS;

  let settlePort!: (port: number) => void;
  let rejectPort!: (error: Error) => void;
  const ready = new Promise<number>((resolve, reject) => {
    settlePort = resolve;
    rejectPort = reject;
  });

  // Teardown is assigned after the server is up; `closing` guards against
  // double-close (e.g. shutdown request + signal at the same time).
  let closing = false;
  let teardown: () => Promise<void> = async () => {};

  const worker = new IndexingWorker({
    db,
    embedder: workerOptions.embedder,
    vectors: workerOptions.vectors,
  });
  const semantic = new SemanticSearch({
    embedder: workerOptions.embedder,
    vectors: workerOptions.vectors,
    cards: createCardStore(db),
  });
  const timers = new JobTimers(db);

  const app = createApp({
    db,
    token,
    version: getVersion(),
    pid: process.pid,
    startedAt: Date.now(),
    allowedHosts: getAllowedHosts(),
    injectWebToken: isLoopbackHost(host),
    requestShutdown: () => {
      if (closing) return;
      closing = true;
      // Give the HTTP response a moment to flush before closing sockets.
      setTimeout(() => {
        void teardown();
      }, SHUTDOWN_FLUSH_DELAY_MS);
    },
    semantic,
    webDist: options.webDist === null ? undefined : (options.webDist ?? defaultWebDist()),
  });
  // `overrideGlobalObjects: false` keeps the native global Request/Response:
  // the Hono shim classes break `response instanceof Response` checks inside
  // Transformers.js, which silently disables its model file cache and makes
  // the first model download fail ("Unable to get model file path or buffer").
  const server: ServerType = serve(
    { fetch: app.fetch, hostname: host, port, overrideGlobalObjects: false },
    info => settlePort(info.port)
  );
  server.once('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      rejectPort(new PortInUseError(port));
    } else {
      rejectPort(error);
    }
  });

  let actualPort: number;
  try {
    actualPort = await ready;
  } catch (error) {
    // Never started listening; ignore the ERR_SERVER_NOT_RUNNING callback error.
    server.close(() => {});
    db.close();
    throw error;
  }

  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => {
    resolveClosed = resolve;
  });

  // Worker startup can be slow (first run downloads the embedding model)
  // and can fail (offline). It must never take the HTTP server down, so
  // it runs in the background with retries; semantic search stays "not
  // ready" (auto mode degrades to keyword) until it succeeds. A missing
  // optional package is permanent: the daemon stays up in keyword-only
  // mode and does not retry.
  const startWorkerInBackground = async (): Promise<void> => {
    for (;;) {
      try {
        await worker.start();
        if (!closing) {
          semantic.setReady(true);
        }
        return;
      } catch (error) {
        if (isModuleNotFound(error)) {
          semantic.markNotInstalled();
          console.error(
            'memhub: the semantic stack is not installed; running in keyword-only mode.'
          );
          console.error(`memhub: ${SEMANTIC_INSTALL_HINT}`);
          return;
        }
        console.error('memhub: indexing worker failed to start:', errorMessage(error));
      }
      const aborted = await sleepOrAborted(retryDelayMs, () => closing);
      if (aborted) return;
    }
  };
  const workerTask = startWorkerInBackground();

  timers.start();

  teardown = async (): Promise<void> => {
    closing = true;
    // Teardown must always settle `closed`, even when a step fails: a
    // rejected promise here would leave handle.close() awaiting forever.
    try {
      timers.stop();
      await worker.stop();
      await workerTask;
      const nodeServer = server as Server;
      const closePromise = new Promise<void>(resolve => {
        nodeServer.close(() => resolve());
      });
      // End idle keep-alive connections so close() does not hang.
      nodeServer.closeAllConnections?.();
      await closePromise;
    } catch (error) {
      console.error('memhub: error during shutdown:', errorMessage(error));
    } finally {
      try {
        db.close();
      } catch (error) {
        console.error('memhub: error closing the database:', errorMessage(error));
      }
      resolveClosed();
    }
  };

  return {
    host,
    port: actualPort,
    pid: process.pid,
    closed,
    close: async () => {
      if (closing) {
        await closed;
        return;
      }
      closing = true;
      await teardown();
    },
  };
}

/** Milliseconds to wait before closing sockets after a shutdown request. */
export const SHUTDOWN_FLUSH_DELAY_MS = 100;

/** Whether a bind address is loopback (local-only daemon). */
export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/** Build a CardStore over an open database (used by the semantic search join). */
function createCardStore(db: DatabaseSync): CardStore {
  return new CardStore(db, { events: new EventStore(db), activity: new ActivityLog(db) });
}

/** Sleep that resolves early (true) when the abort check fires. */
async function sleepOrAborted(
  ms: number,
  shouldAbort: () => boolean,
  checkIntervalMs = 100
): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (shouldAbort()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(checkIntervalMs, deadline - Date.now()));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
