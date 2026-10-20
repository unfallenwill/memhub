/**
 * The declarative command registry.
 *
 * Every command is described once: its name, the usage line, the
 * options it accepts and a loader that pulls the implementation in on
 * demand. The --help text is generated from this table, so adding a
 * command means adding one entry instead of editing a usage string in
 * three places.
 *
 * The implementations are loaded lazily: `memhub add` never pulls in
 * the Hono application, the SQLite layer or the embedding stack.
 */

import { errorMessage } from '../core/util/errors.js';
import { getVersion } from '../version.js';
import type { CommandImplementation } from './types.js';

// The command contract lives in ./types.js, so the registry and the
// command modules do not import each other. It is re-exported here
// because the registry is the place consumers look for it.
export type { CommandImplementation } from './types.js';

/** A documented command-line option. */
export interface OptionDoc {
  /** The flag spellings, e.g. '--port, -p <number>'. */
  readonly flags: string;
  /** What the option does. */
  readonly description: string;
}

/** One CLI command. */
export interface CommandSpec {
  /** The name as typed on the command line. */
  readonly name: string;
  /** One-line summary shown in the usage table. */
  readonly summary: string;
  /** The usage line without the leading "memhub ". */
  readonly usage: string;
  /** The options this command documents on its own. */
  readonly options?: readonly OptionDoc[] | undefined;
  /** Load the implementation on demand. */
  load(): Promise<CommandImplementation>;
}

/**
 * Every command the CLI understands.
 *
 * The loaders are static entries that import their module lazily: the
 * table itself stays free of the daemon, the database and the HTTP
 * stack.
 */
export const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'server',
    summary: 'Start the daemon (background by default)',
    usage: 'server [--port 7800] [--foreground]',
    load: () => import('./commands/server.js').then(module => module.serverCommand),
  },
  {
    name: 'status',
    summary: 'Show daemon status',
    usage: 'status [--port 7800]',
    load: () => import('./commands/status.js').then(module => module.statusCommand),
  },
  {
    name: 'stop',
    summary: 'Stop the daemon',
    usage: 'stop [--port 7800]',
    load: () => import('./commands/stop.js').then(module => module.stopCommand),
  },
  {
    name: 'reindex',
    summary: 'Rebuild the vector index from SQLite',
    usage: 'reindex',
    load: () => import('./commands/reindex.js').then(module => module.reindexCommand),
  },
  {
    name: 'add',
    summary: 'Write a memory card (agent-facing)',
    usage: 'add [options]',
    options: [
      { flags: '--title <text>', description: 'Card title (required)' },
      { flags: '--body <text>', description: 'Card body; omit to read it from stdin' },
      {
        flags: '--type <type>',
        description: 'fact | preference | decision | insight | pattern (default insight)',
      },
      { flags: '--cues <text>', description: 'Retrieval cue; repeat the flag for multiple cues' },
      { flags: '--writer <name>', description: "Who wrote the card (e.g. the agent's name)" },
      {
        flags: '--base-url <url>',
        description: 'Remote daemon (memhub login target) instead of local',
      },
    ],
    load: () => import('./commands/add.js').then(module => module.addCommand),
  },
  {
    name: 'search',
    summary: 'Search cards, print one-line JSON',
    usage: 'search <query> [options]',
    options: [
      { flags: '--mode <mode>', description: 'auto | semantic | keyword (default auto)' },
      { flags: '--limit <number>', description: 'Max results, 1-100 (default 10)' },
      {
        flags: '--base-url <url>',
        description: 'Remote daemon (memhub login target) instead of local',
      },
    ],
    load: () => import('./commands/search.js').then(module => module.searchCommand),
  },
  {
    name: 'login',
    summary: 'Log in to a remote daemon (device flow)',
    usage: 'login [--base-url <url>]',
    load: () => import('./commands/login.js').then(module => module.loginCommand),
  },
  {
    name: 'logout',
    summary: 'Revoke the stored login token',
    usage: 'logout',
    load: () => import('./commands/logout.js').then(module => module.logoutCommand),
  },
  {
    name: 'config',
    summary: 'Configure the CLI (key: base-url)',
    usage: 'config <set|get|list|unset> [key]',
    load: () => import('./commands/config.js').then(module => module.configCommand),
  },
  {
    name: 'reset-password',
    summary: 'Clear the admin password (on the server)',
    usage: 'reset-password',
    load: () => import('./commands/reset-password.js').then(module => module.resetPasswordCommand),
  },
];

/** The options every command understands. */
const GLOBAL_OPTIONS: readonly OptionDoc[] = [
  { flags: '--port, -p <number>', description: 'Daemon port (default 7800, or MEMHUB_PORT)' },
  {
    flags: '--foreground, -f',
    description: 'Run the server in the foreground (server command only)',
  },
];

/** The environment variables the CLI and the daemon read. */
const ENVIRONMENT: readonly OptionDoc[] = [
  { flags: 'MEMHUB_HOME', description: 'Data directory (default ~/.memhub)' },
  { flags: 'MEMHUB_HOST', description: 'Bind address (default 127.0.0.1)' },
  { flags: 'MEMHUB_PORT', description: 'Default daemon port (default 7800)' },
  { flags: 'MEMHUB_TOKEN', description: 'Fixed API token (default: generated into <home>/token)' },
  {
    flags: 'MEMHUB_ALLOWED_HOSTS',
    description: 'Extra allowed Host header values, comma-separated',
  },
];

/** How add and search pick the daemon they talk to. */
const TARGET_NOTE = [
  'Target resolution for add/search: --base-url and --port are mutually',
  'exclusive. Without --base-url, an explicit --port means the local',
  'daemon; otherwise the configured default (memhub config set base-url',
  '<url>) applies, and finally the local daemon.',
].join('\n');

/** The width the usage column is padded to. */
const USAGE_COLUMN = 46;
/** The width the option column is padded to. */
const OPTION_COLUMN = 21;

function usageLine(usage: string, summary: string): string {
  return `  ${usage.padEnd(USAGE_COLUMN)}  ${summary}`;
}

function optionLine(option: OptionDoc): string {
  return `  ${option.flags.padEnd(OPTION_COLUMN)}  ${option.description}`;
}

/** Render the --help text from the command table. */
export function renderUsage(): string {
  const lines: string[] = [];
  lines.push(`MemHub CLI v${getVersion()} - local memory card daemon for AI agents`);
  lines.push('');
  lines.push('Usage:');
  for (const command of COMMANDS) {
    lines.push(usageLine(`memhub ${command.usage}`, command.summary));
  }
  lines.push(usageLine('memhub --help', 'Show this help message'));
  lines.push(usageLine('memhub --version', 'Show version'));
  lines.push('');
  lines.push('Options:');
  for (const option of GLOBAL_OPTIONS) {
    lines.push(optionLine(option));
  }
  for (const command of COMMANDS) {
    if (command.options === undefined) continue;
    lines.push('');
    lines.push(`memhub ${command.name} options:`);
    for (const option of command.options) {
      lines.push(optionLine(option));
    }
  }
  lines.push('');
  lines.push(TARGET_NOTE);
  lines.push('');
  lines.push('Environment:');
  for (const entry of ENVIRONMENT) {
    lines.push(optionLine(entry));
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Run the command named by the first argument.
 *
 * Returns the process exit code. An unknown command is reported here;
 * a usage error thrown by a command propagates to the caller.
 */
export async function dispatch(argv: readonly string[]): Promise<number> {
  const name = argv[0];
  if (name === undefined || name === '--help' || name === '-h') {
    console.log(renderUsage());
    return name === undefined ? 1 : 0;
  }
  if (name === '--version' || name === '-v') {
    console.log(`MemHub CLI v${getVersion()}`);
    return 0;
  }
  const spec = COMMANDS.find(command => command.name === name);
  if (spec === undefined) {
    console.error(`Unknown command: ${name}`);
    console.error('Run "memhub --help" for usage information.');
    return 1;
  }
  let implementation: CommandImplementation;
  try {
    implementation = await spec.load();
  } catch (error) {
    console.error(`Error: cannot load the "${name}" command: ${errorMessage(error)}`);
    return 1;
  }
  const options = implementation.parse(argv.slice(1));
  return await implementation.run(options);
}
