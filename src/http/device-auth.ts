/**
 * Re-export shim of the device authorization flow.
 *
 * The implementation moved to ./routes/device-auth.js, where it lives
 * next to the other route modules. This module keeps the old import
 * path working (it is part of the package's public surface).
 */

export * from './routes/device-auth.js';
