/**
 * Shim for node:sqlite under vitest.
 *
 * vitest 1.x (vite-node) predates node:sqlite: its builtin-module list
 * does not know "sqlite", so importing it through the transform pipeline
 * fails. vitest.config.ts aliases `node:sqlite` to this file, which loads
 * the real module through createRequire at runtime. Production code
 * imports node:sqlite directly and is unaffected.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const sqlite = nodeRequire('node:sqlite') as typeof import('node:sqlite');

export const DatabaseSync = sqlite.DatabaseSync;
