/**
 * MemHub - local memory card daemon for AI coding agents.
 *
 * The public API surface of the package. The re-exports follow the layer
 * structure (see docs/architecture.md):
 *
 *   core/     pure domain layer (types, policies, ports)
 *   db/       SQLite adapters
 *   embedding/  storage/  worker/  http/  daemon/  services/
 *
 * The legacy top-level modules (paths, semantic-stack, version) stay
 * exported so that existing consumers keep working.
 */

export * from './core/index.js';
export * from './auth/index.js';
export * from './db/index.js';
export * from './embedding/index.js';
export * from './http/index.js';
export * from './daemon/index.js';
export * from './runtime/context.js';
export * from './runtime/semantic.js';
export * from './services/index.js';
export * from './storage/index.js';
export * from './worker/index.js';
export * from './paths.js';
export * from './semantic-stack.js';
export * from './version.js';

/**
 * `CardVectorStore` exists twice: as the deprecated alias in
 * `src/core/ports/vector.ts` and as the backwards-compatibility alias in
 * `src/storage/vector-index.ts`. The storage one wins here, because that
 * is the name the package has always exported.
 */
export type { CardVectorStore } from './storage/index.js';
