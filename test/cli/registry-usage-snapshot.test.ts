/**
 * The generated help text of the CLI.
 *
 * The help is rendered from the command table, so it changes whenever a
 * command or an option changes. This test freezes the current text: a
 * script that greps the help output keeps working, and a change of the
 * wording has to be a deliberate one.
 */

import { describe, expect, it } from 'vitest';
import { renderUsage } from '../../src/cli/registry.js';
import { getVersion } from '../../src/version.js';

const EXPECTED_USAGE = `MemHub CLI v${getVersion()} - local memory card daemon for AI agents

Usage:
  memhub server [--port 7800] [--foreground]      Start the daemon (background by default)
  memhub status [--port 7800]                     Show daemon status
  memhub stop [--port 7800]                       Stop the daemon
  memhub reindex                                  Rebuild the vector index from SQLite
  memhub add [options]                            Write a memory card (agent-facing)
  memhub search <query> [options]                 Search cards, print one-line JSON
  memhub login [--base-url <url>]                 Log in to a remote daemon (device flow)
  memhub logout                                   Revoke the stored login token
  memhub config <set|get|list|unset> [key]        Configure the CLI (key: base-url)
  memhub reset-password                           Clear the admin password (on the server)
  memhub --help                                   Show this help message
  memhub --version                                Show version

Options:
  --port, -p <number>    Daemon port (default 7800, or MEMHUB_PORT)
  --foreground, -f       Run the server in the foreground (server command only)

memhub add options:
  --title <text>         Card title (required)
  --body <text>          Card body; omit to read it from stdin
  --type <type>          fact | preference | decision | insight | pattern (default insight)
  --cues <text>          Retrieval cue; repeat the flag for multiple cues
  --writer <name>        Who wrote the card (e.g. the agent's name)
  --base-url <url>       Remote daemon (memhub login target) instead of local

memhub search options:
  --mode <mode>          auto | semantic | keyword (default auto)
  --limit <number>       Max results, 1-100 (default 10)
  --base-url <url>       Remote daemon (memhub login target) instead of local

Target resolution for add/search: --base-url and --port are mutually
exclusive. Without --base-url, an explicit --port means the local
daemon; otherwise the configured default (memhub config set base-url
<url>) applies, and finally the local daemon.

Environment:
  MEMHUB_HOME            Data directory (default ~/.memhub)
  MEMHUB_HOST            Bind address (default 127.0.0.1)
  MEMHUB_PORT            Default daemon port (default 7800)
  MEMHUB_TOKEN           Fixed API token (default: generated into <home>/token)
  MEMHUB_ALLOWED_HOSTS   Extra allowed Host header values, comma-separated
`;

describe('the help text of the CLI', () => {
  it('renders the frozen text', () => {
    expect(renderUsage()).toBe(EXPECTED_USAGE);
  });
});
