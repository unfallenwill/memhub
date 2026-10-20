/**
 * Remove the compiled output directory.
 *
 * tsc never deletes the .js of a module whose source disappeared, so a
 * refactor that moves a file (say src/cli/commands/server.ts) leaves
 * the old src/cli/server.js behind. Those stale modules are dead code
 * that still gets published: the npm tarball would ship the daemon
 * twice under two layouts, and the Docker image would carry them too.
 *
 * Cleaning before every build keeps dist/ an exact mirror of src/.
 */

import { rmSync } from 'node:fs';

rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });
