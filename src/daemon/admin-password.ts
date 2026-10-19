/**
 * Re-export shim: the admin password implementation now lives in
 * src/auth/ (shared by the daemon and the HTTP adapter). This module
 * keeps the historical import path working.
 */

export * from '../auth/admin-password.js';
