/**
 * Data directory resolution.
 *
 * MemHub keeps a single global store under ~/.memhub by default.
 * The location can be overridden with the MEMHUB_HOME environment
 * variable (used by tests to point at temporary directories).
 *
 * The implementation now lives in the config layer (src/config/), which
 * is the only place that reads process.env. This module stays as the
 * legacy entry point: every name it used to export is still available.
 */

export * from './config/paths.js';
