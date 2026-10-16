#!/usr/bin/env node
/**
 * MemHub CLI entry point.
 *
 * Commands:
 *   memhub server [--port 7800] [--foreground]   start the daemon
 *   memhub status [--port 7800]                   show daemon status
 *   memhub stop [--port 7800]                     stop the daemon
 *   memhub reindex                                rebuild the vector index
 *   memhub add [options]                          write a memory card
 *   memhub search <query> [options]               search cards
 *   memhub login <url>                            authorize against a remote daemon
 *   memhub logout                                 revoke the stored login token
 *   memhub reset-password                         clear the admin password (server-side)
 *   memhub --help / --version
 */

import { getVersion } from '../version.js';
import { parseAddArgs, runAddCommand } from './add.js';
import { runLoginCommand, parseLoginArgs } from './login.js';
import { runLogoutCommand } from './logout.js';
import { runReindexCommand } from './reindex.js';
import { runResetPasswordCommand } from './reset-password.js';
import { parseSearchArgs, runSearchCommand } from './search.js';
import { parseServerArgs, runServerCommand } from './server.js';
import { runStatusCommand } from './status.js';
import { runStopCommand } from './stop.js';
import { getDefaultPort } from '../paths.js';

const USAGE = `MemHub CLI v${getVersion()} - local memory card daemon for AI agents

Usage:
  memhub server [--port 7800] [--foreground]   Start the daemon (background by default)
  memhub status [--port 7800]                   Show daemon status
  memhub stop [--port 7800]                     Stop the daemon
  memhub reindex                                Rebuild the vector index from SQLite
  memhub add [options]                          Write a memory card (agent-facing)
  memhub search <query> [options]               Search cards, print one-line JSON
  memhub login <url>                            Log in to a remote daemon (device flow)
  memhub logout                                 Revoke the stored login token
  memhub reset-password                         Clear the admin password (on the server)
  memhub --help                                 Show this help message
  memhub --version                              Show version

Options:
  --port, -p <number>    Daemon port (default 7800, or MEMHUB_PORT)
  --foreground, -f       Run the server in the foreground (server command only)

memhub add options:
  --title <text>         Card title (required)
  --body <text>          Card body; omit to read it from stdin
  --type <type>          fact | preference | decision | insight | pattern (default insight)
  --cues <text>          Retrieval cue; repeat the flag for multiple cues
  --writer <name>        Who wrote the card (e.g. the agent's name)
  --url <url>            Remote daemon (memhub login target) instead of local

memhub search options:
  --mode <mode>          auto | semantic | keyword (default auto)
  --limit <number>       Max results, 1-100 (default 10)
  --url <url>            Remote daemon (memhub login target) instead of local

Environment:
  MEMHUB_HOME            Data directory (default ~/.memhub)
  MEMHUB_HOST            Bind address (default 127.0.0.1)
  MEMHUB_PORT            Default daemon port (default 7800)
  MEMHUB_TOKEN           Fixed API token (default: generated into <home>/token)
  MEMHUB_ALLOWED_HOSTS   Extra allowed Host header values, comma-separated
`;

function printHelp(): void {
  console.log(USAGE);
}

function printVersion(): void {
  console.log(`MemHub CLI v${getVersion()}`);
}

/** Parse a --port option shared by all commands. */
function parsePort(argv: readonly string[], command: string): number {
  let port = getDefaultPort();
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
  if (command === 'add') {
    return runAddCommand(parseAddArgs(rest));
  }
  if (command === 'search') {
    return runSearchCommand(parseSearchArgs(rest));
  }
  if (command === 'login') {
    return runLoginCommand(parseLoginArgs(rest));
  }
  if (command === 'logout') {
    if (rest.length > 0) {
      throw new Error(`unknown option for logout: ${rest[0]}`);
    }
    return runLogoutCommand();
  }
  if (command === 'reset-password') {
    if (rest.length > 0) {
      throw new Error(`unknown option for reset-password: ${rest[0]}`);
    }
    return runResetPasswordCommand();
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
