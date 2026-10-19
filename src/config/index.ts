/**
 * The MemHub configuration layer.
 *
 * The single place where the process environment is read (env.ts) and the
 * single place where the data directory layout is defined (paths.ts).
 * The daemon configuration itself is assembled in src/daemon/config.ts,
 * on top of these readers.
 */

export * from './env.js';
export * from './paths.js';
