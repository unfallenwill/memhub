/**
 * Re-export shim: the first-run setup code now lives in src/auth/
 * (shared by the daemon and the HTTP adapter). This module keeps the
 * historical import path working.
 */

export * from '../auth/setup-code.js';
