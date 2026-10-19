/**
 * CLI configuration file (~/.memhub/config.json, written by `memhub config`).
 *
 * Unlike credentials.json this holds no secrets — it only routes CLI
 * commands (which daemon `add`/`search` talk to). Missing or malformed
 * files read as an empty config, same policy as readCredentials.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { getConfigPath, getMemhubHome } from '../paths.js';

/** Shape of the config file. */
export interface StoredConfig {
  readonly version: 1;
  /** Default remote daemon base URL; unset means "local daemon". */
  readonly base_url?: string | undefined;
}

/** CLI-side config key names (kebab-case, as typed by the user). */
export type ConfigKey = 'base-url';

/** All keys supported by `memhub config` in this version. */
export const CONFIG_KEYS: readonly ConfigKey[] = ['base-url'];

/** Map a CLI key to its JSON field in StoredConfig. */
const KEY_TO_FIELD: Readonly<Record<ConfigKey, 'base_url'>> = {
  'base-url': 'base_url',
};

/** Type guard for values typed by the user as a config key. */
export function isConfigKey(value: string | undefined): value is ConfigKey {
  return value !== undefined && (CONFIG_KEYS as readonly string[]).includes(value);
}

/** Read the config; missing or malformed files read as an empty config. */
export function readConfig(home: string = getMemhubHome()): StoredConfig {
  const path = getConfigPath(home);
  if (!existsSync(path)) return { version: 1 };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<StoredConfig>;
    if (parsed.version === 1) {
      return {
        version: 1,
        ...(typeof parsed.base_url === 'string' && parsed.base_url !== ''
          ? { base_url: parsed.base_url }
          : {}),
      };
    }
  } catch {
    // fall through: unreadable config counts as empty
  }
  return { version: 1 };
}

/** Write the config with restrictive permissions. */
export function writeConfig(home: string, config: StoredConfig): void {
  const path = getConfigPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
  // writeFileSync only applies the mode when creating: re-assert it so a
  // rewrite never leaves a previously loosened mode in place.
  chmodSync(path, 0o600);
}

/** Read one key's current value, or undefined when unset. */
export function getConfigValue(home: string, key: ConfigKey): string | undefined {
  return readConfig(home)[KEY_TO_FIELD[key]];
}

/** Set one key; returns the updated config. */
export function setConfigValue(home: string, key: ConfigKey, value: string): StoredConfig {
  const config = { ...readConfig(home), [KEY_TO_FIELD[key]]: value } as StoredConfig;
  writeConfig(home, config);
  return config;
}

/** Unset one key (idempotent); returns the updated config. */
export function unsetConfigValue(home: string, key: ConfigKey): StoredConfig {
  const current = readConfig(home);
  const field = KEY_TO_FIELD[key];
  if (current[field] === undefined) return current;
  const copy: { version: 1; base_url?: string } = { ...current };
  delete copy[field];
  writeConfig(home, copy);
  return copy;
}
