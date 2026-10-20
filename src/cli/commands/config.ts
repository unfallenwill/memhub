/**
 * `memhub config` command.
 *
 * Reads and writes the CLI configuration (~/.memhub/config.json).
 * v1 supports a single key: base-url, the remote daemon that
 * `add`/`search` target when neither --base-url nor --port is given.
 */

import { getMemhubHome } from '../../paths.js';
import {
  CONFIG_KEYS,
  getConfigValue,
  isConfigKey,
  readConfig,
  setConfigValue,
  unsetConfigValue,
  type ConfigKey,
} from '../config-file.js';
import { normalizeBaseUrl } from '../credentials.js';
import type { CommandImplementation } from '../types.js';

/** Options for the config command (discriminated on the subcommand). */
export type ConfigCommandOptions =
  | { readonly action: 'list'; readonly home?: string | undefined }
  | {
      readonly action: 'set';
      readonly key: ConfigKey;
      readonly value: string;
      readonly home?: string | undefined;
    }
  | {
      readonly action: 'get' | 'unset';
      readonly key: ConfigKey;
      readonly home?: string | undefined;
    };

const USAGE = 'usage: memhub config <set|get|list|unset> [key] [value]  (supported key: base-url)';

function unknownKey(value: string): string {
  return `unknown config key: ${value} (supported: ${CONFIG_KEYS.join(', ')})`;
}

/** Parse `memhub config` arguments. Throws on invalid input. */
export function parseConfigArgs(argv: readonly string[]): ConfigCommandOptions {
  const action = argv[0];
  const rest = argv.slice(1);
  if (action === 'list') {
    if (rest.length !== 0) throw new Error(USAGE);
    return { action };
  }
  if (action === 'set') {
    if (rest.length !== 2) throw new Error(USAGE);
    if (!isConfigKey(rest[0])) throw new Error(unknownKey(rest[0]));
    return { action, key: rest[0], value: rest[1] };
  }
  if (action === 'get' || action === 'unset') {
    if (rest.length !== 1) throw new Error(USAGE);
    if (!isConfigKey(rest[0])) throw new Error(unknownKey(rest[0]));
    return { action, key: rest[0] };
  }
  throw new Error(USAGE);
}

/** Run the config command. Returns the process exit code. */
export function runConfigCommand(options: ConfigCommandOptions): number {
  const home = options.home ?? getMemhubHome();
  switch (options.action) {
    case 'list': {
      const config = readConfig(home);
      if (config.base_url !== undefined) console.log(`base-url=${config.base_url}`);
      return 0;
    }
    case 'set': {
      const baseUrl = normalizeBaseUrl(options.value);
      if (baseUrl === null) {
        console.error(
          `invalid base URL: ${options.value} (expected https://memhub.example.com, no path)`
        );
        return 1;
      }
      setConfigValue(home, options.key, baseUrl);
      console.log(`base-url = ${baseUrl}`);
      return 0;
    }
    case 'get': {
      const value = getConfigValue(home, options.key);
      if (value === undefined) {
        // stderr + exit 1 so `$(memhub config get base-url)` captures nothing.
        console.error(`${options.key} is not set`);
        return 1;
      }
      console.log(value);
      return 0;
    }
    case 'unset': {
      const existed = getConfigValue(home, options.key) !== undefined;
      unsetConfigValue(home, options.key);
      console.log(existed ? `${options.key} unset` : `${options.key} was not set`);
      return 0;
    }
  }
}

/** The config command, as the registry sees it. */
export const configCommand: CommandImplementation<ConfigCommandOptions> = {
  parse: parseConfigArgs,
  run: options => Promise.resolve(runConfigCommand(options)),
};
