#!/usr/bin/env node
/**
 * MemHub CLI entry point.
 *
 * Commands:
 *   memhub server [--port 7800] [--foreground]   start the daemon
 *   memhub status [--port 7800]                   show daemon status
 *   memhub stop [--port 7800]                     stop the daemon
 *   memhub reindex                                rebuild the vector index
 *   memhub --help / --version
 */

import { getVersion } from '../version.js';
import { runReindexCommand } from './reindex.js';
import { parseServerArgs, runServerCommand } from './server.js';
import { runStatusCommand } from './status.js';
import { runStopCommand } from './stop.js';

const USAGE = `MemHub CLI v${getVersion()} - local memory card daemon for AI agents

Usage:
  memhub server [--port 7800] [--foreground]   Start the daemon (background by default)
  memhub status [--port 7800]                   Show daemon status
  memhub stop [--port 7800]                     Stop the daemon
  memhub reindex                                Rebuild the vector index from SQLite
  memhub --help                                 Show this help message
  memhub --version                              Show version

Options:
  --port, -p <number>    Daemon port (default 7800)
  --foreground, -f       Run the server in the foreground (server command only)
`;

function printHelp(): void {
  console.log(USAGE);
}

function printVersion(): void {
  console.log(`MemHub CLI v${getVersion()}`);
}

/** Parse a --port option shared by all commands. */
function parsePort(argv: readonly string[], command: string): number {
  let port = 7800;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' || arg === '-p') {
      const value = argv[++i];
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        throw new Error(`invalid --port value: ${value ?? '(missing)'}`);
      }
      port = parsed;
    } else {
      throw new Error(`unknown option for ${command}: ${arg}`);
    }
  }
  return port;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === undefined || command === '--help' || command === '-h') {
    printHelp();
    return command === undefined ? 1 : 0;
  }
  if (command === '--version' || command === '-v') {
    printVersion();
    return 0;
  }

  const rest = args.slice(1);
  if (command === 'server') {
    return runServerCommand(parseServerArgs(rest));
  }
  if (command === 'status') {
    return runStatusCommand({ port: parsePort(rest, 'status') });
  }
  if (command === 'stop') {
    return runStopCommand({ port: parsePort(rest, 'stop') });
  }
  if (command === 'reindex') {
    if (rest.length > 0) {
      throw new Error(`unknown option for reindex: ${rest[0]}`);
    }
    return runReindexCommand();
  }

  console.error(`Unknown command: ${command}`);
  console.error('Run "memhub --help" for usage information.');
  return 1;
}

main()
  .then(code => {
    process.exitCode = code;
  })
  .catch(error => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
