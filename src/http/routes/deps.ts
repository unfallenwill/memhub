/**
 * The dependency contracts of the HTTP adapter.
 *
 * The app is assembled from independent route modules (see ./routes/):
 * each of them declares the small slice of the process it needs, and
 * the composition root (src/http/app.ts) wires them together. The two
 * contracts every module shares live here: the slice of the runtime
 * context the HTTP adapter works on, and the dependencies the daemon
 * injects into createApp().
 */

import type {
  AdminPasswordRepository,
  DeviceTokenRepository,
  WorkerStateRepository,
} from '../../core/ports/repositories.js';
import type { SemanticSearchBackend } from '../../core/ports/search.js';
import type { CardService } from '../../services/card-service.js';
import type { SearchService } from '../../services/search-service.js';

/**
 * The slice of the runtime context the HTTP adapter works on.
 *
 * The daemon hands the object graph of the composition root
 * (src/runtime/context.ts) to the app; it satisfies this interface
 * structurally, so the HTTP layer stays free of any knowledge about the
 * composition root (and about the database driver).
 */
export interface AppContext {
  /** Device-flow tokens. */
  readonly deviceTokens: DeviceTokenRepository;
  /** The admin password. */
  readonly adminPassword: AdminPasswordRepository;
  /** The state of the indexing worker. */
  readonly workerState: WorkerStateRepository;
  /** The search service (mode router over the two backends). */
  readonly search: SearchService;
  /**
   * The card use cases.
   *
   * The card routes go through the service, not through the store: the
   * service owns the lifecycle rules (a card can only be superseded by
   * a card that exists) and reports them as results the transport layer
   * can translate.
   */
  readonly cardService: CardService;
  /** Semantic retrieval backend; null in keyword-only mode. */
  readonly semantic: SemanticSearchBackend | null;
}

/** Dependencies injected into the app (keeps it testable). */
export interface AppDeps {
  /**
   * The object graph of the process. The app never builds a store of its
   * own: it uses exactly the instances the composition root created, so
   * the HTTP app, the indexing worker and the semantic search share one
   * store graph.
   */
  readonly context: AppContext;
  readonly token: string;
  readonly version: string;
  readonly pid: number;
  /** Wall-clock ms timestamp used to compute uptime. */
  readonly startedAt: number;
  /** Called by POST /api/shutdown; the daemon closes itself gracefully. */
  readonly requestShutdown: () => void;
  /**
   * Additional Host header values accepted besides the local defaults
   * (localhost, 127.0.0.1, [::1]). Used by cloud deployments behind a
   * proxy; entries match case-insensitively with any :port ignored.
   * A single "*" accepts every Host header.
   */
  readonly allowedHosts?: readonly string[] | undefined;
  /**
   * Directory of the built web UI (web/dist). When set, the SPA is served
   * at GET / with the API token injected into index.html; static assets
   * are token-exempt like the page itself. Null/undefined disables the
   * web UI (JSON 404s).
   */
  readonly webDist?: string | undefined;
  /**
   * Whether the served index.html may embed the daemon token. Only true
   * for loopback-bound daemons: on a remote host the page HTML must not
   * carry an all-powerful token (anyone who can open the page would get
   * one) — remote web sessions use `memhub login` device tokens instead.
   */
  readonly injectWebToken?: boolean | undefined;
  /** Clock override for the device-flow endpoints (tests). */
  readonly authNow?: (() => number) | undefined;
  /** Lazily supplies the first-run setup code; null/omitted = setup refused. */
  readonly getSetupCode?: (() => string | null) | undefined;
  /** Path of the setup code file on the server (shown on the login page). */
  readonly setupCodePath?: string | undefined;
  /** Called after the admin password was set through the setup flow. */
  readonly onSetupComplete?: (() => void) | undefined;
}
