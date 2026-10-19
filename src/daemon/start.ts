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
 *
 * This module is the orchestration layer only: the configuration is
 * resolved in ./config.ts, the socket is bound in ./server.ts, the
 * worker startup strategy lives in ./worker-bootstrap.ts and the object
 * graph of the process is built by the composition root
 * (src/runtime/context.ts) - the app, the worker and the timers all work
 * on the very same store instances.
 */

import { chmodSync, mkdirSync, rmSync } from 'fs';
import {
  getAllowedHosts,
  getDatabasePath,
  getLanceDbPath,
  getModelsDir,
  getSetupCodePath,
  getTokenPath,
} from '../config/paths.js';
import { openDatabase } from '../db/database.js';
import type { EmbeddingProvider } from '../embedding/embedder.js';
import { TransformersEmbedder } from '../embedding/transformers-embedder.js';
import { createApp } from '../http/app.js';
import { createRuntimeContext, type RuntimeContext } from '../runtime/context.js';
import { logDaemonError } from '../core/util/log.js';
import { SemanticSearch } from '../services/semantic-search.js';
import type { CardVectorStore } from '../storage/vector-index.js';
import { LanceVectorIndex } from '../storage/vector-index.js';
import { getVersion } from '../version.js';
import { IndexingWorker } from '../worker/indexer-worker.js';
import { JobTimers } from '../worker/timers.js';
import { resolveDaemonConfig } from './config.js';
import { startHttpServer, type HttpServerHandle } from './server.js';
import { ensureSetupCodeFile } from './setup-code.js';
import { resolveToken } from './token.js';
import {
  startWorkerInBackground,
  type IndexingWorkerHandle,
  type SemanticReadiness,
} from './worker-bootstrap.js';

// The port error is defined next to the code that raises it, but the
// daemon has always been its public home (the CLI imports it there).
export { PortInUseError } from './server.js';

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
  /** Port to bind. 0 picks a free port. Defaults to MEMHUB_PORT or 7800. */
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
  /**
   * The indexing worker to run. Defaults to an IndexingWorker built from
   * the worker options; tests inject a fake (e.g. one whose stop() fails).
   */
  readonly indexer?: IndexingWorkerHandle | undefined;
}

/** How often a failed worker startup (e.g. model download) is retried. */
export const WORKER_START_RETRY_MS = 60_000;

/** Build the production worker context (no I/O happens at construction). */
export function createDefaultWorkerContext(home: string): DaemonWorkerOptions {
  const embedder = new TransformersEmbedder({ cacheDir: getModelsDir(home) });
  return {
    embedder,
    // The store validates the dimensionality of every write, so a
    // provider that produces vectors of a different length cannot
    // silently corrupt the LanceDB table schema.
    vectors: new LanceVectorIndex(getLanceDbPath(home), { dimensions: embedder.dimensions }),
  };
}

/**
 * Start the MemHub daemon in the current process.
 * Rejects with PortInUseError when the port cannot be bound.
 */
export async function startDaemon(options: DaemonOptions = {}): Promise<DaemonHandle> {
  const { home, port, host, webDist } = resolveDaemonConfig(options);
  // The home directory holds the token, setup code, database and logs:
  // tighten it to owner-only (best effort — an existing directory the
  // daemon cannot chmod, e.g. a container volume, is left as-is).
  mkdirSync(home, { recursive: true, mode: 0o700 });
  try {
    chmodSync(home, 0o700);
  } catch {
    // best-effort hardening only
  }

  const token = resolveToken(getTokenPath(home));
  const db = openDatabase(getDatabasePath(home));
  const workerOptions = options.worker ?? createDefaultWorkerContext(home);
  const retryDelayMs = workerOptions.retryDelayMs ?? WORKER_START_RETRY_MS;

  // The composition root: one store graph for the whole process. The
  // app, the indexing worker, the job timers and the semantic search all
  // work on these very instances.
  const context = createRuntimeContext({
    db,
    embedder: workerOptions.embedder,
    vectors: workerOptions.vectors,
  });

  // Fresh deployment: mint the one-time setup code the very first login
  // must present to set the admin password (proof of server access, so a
  // remote attacker cannot claim an uninitialized server). Supplied to
  // the app lazily: clearing the password (memhub reset-password) while
  // the daemon runs re-enables setup without a restart.
  const setupCodePath = getSetupCodePath(home);
  const adminPasswords = context.adminPassword;
  let setupCodePrinted = false;
  const printSetupCode = (code: string): void => {
    if (setupCodePrinted) return;
    setupCodePrinted = true;
    console.log(`memhub: first-run setup code: ${code}`);
    console.log(`memhub: (also stored at ${setupCodePath}; required to set the admin password)`);
  };
  const getSetupCode = (): string | null => {
    if (adminPasswords.get() !== null) return null;
    try {
      const code = ensureSetupCodeFile(setupCodePath);
      printSetupCode(code);
      return code;
    } catch (error) {
      logDaemonError('failed to mint the setup code', error);
      return null;
    }
  };
  // Mint eagerly on a fresh home so the operator sees the code in the logs.
  getSetupCode();

  // Teardown is assigned after the server is up; `closing` guards against
  // double-close (e.g. shutdown request + signal at the same time).
  let closing = false;
  let teardown: () => Promise<void> = async () => {};

  const worker: IndexingWorkerHandle =
    options.indexer ??
    new IndexingWorker({
      embedder: workerOptions.embedder,
      vectors: workerOptions.vectors,
      // The context satisfies the repository bundle of the worker layer:
      // the worker works on the very same stores as the app.
      repositories: context,
    });
  const semantic = semanticReadiness(context);
  const timers = new JobTimers(context);

  const app = createApp({
    context,
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
    webDist,
    getSetupCode,
    setupCodePath,
    onSetupComplete: () => {
      try {
        rmSync(setupCodePath);
      } catch (error) {
        logDaemonError('failed to remove the setup code file', error);
      }
      // A later password reset mints a fresh code — print it again then.
      setupCodePrinted = false;
    },
  });

  let httpServer: HttpServerHandle;
  try {
    httpServer = await startHttpServer(app, { host, port });
  } catch (error) {
    // Never started listening: release the database and report the error.
    db.close();
    throw error;
  }
  const actualPort = httpServer.port;

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
  const workerTask = startWorkerInBackground({
    worker,
    semantic,
    retryDelayMs,
    isClosing: () => closing,
  });

  timers.start();

  teardown = async (): Promise<void> => {
    closing = true;
    try {
      // Every step is isolated: a failing step must never skip the ones
      // after it. A throwing worker.stop() used to leave the HTTP socket
      // open, because server.close() was never reached.
      try {
        timers.stop();
      } catch (error) {
        logDaemonError('error stopping the job timers', error);
      }
      try {
        await worker.stop();
      } catch (error) {
        logDaemonError('error stopping the indexing worker', error);
      }
      try {
        await workerTask;
      } catch (error) {
        logDaemonError('error waiting for the indexing worker', error);
      }
      try {
        await httpServer.close();
      } catch (error) {
        logDaemonError('error closing the HTTP server', error);
      }
    } finally {
      // Teardown must always settle `closed`, even when a step fails: a
      // rejected promise here would leave handle.close() awaiting forever.
      try {
        db.close();
      } catch (error) {
        logDaemonError('error closing the database', error);
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

/**
 * The semantic backend of the context, when the daemon can control it.
 * The port only exposes the readiness flags; the concrete class knows
 * how to set them.
 */
function semanticReadiness(context: RuntimeContext): SemanticReadiness | null {
  return context.semantic instanceof SemanticSearch ? context.semantic : null;
}
