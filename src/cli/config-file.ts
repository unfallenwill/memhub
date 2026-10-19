/**
 * CLI configuration file (~/.memhub/config.json, written by `memhub config`).
 *
 * Unlike credentials.json this holds no secrets — it only routes CLI
 * commands (which daemon `add`/`search` talk to). A missing file reads
 * as an empty config; a file that exists but cannot be parsed THROWS,
 * because silently treating it as "no default" would route cards to the
 * local daemon — the exact silent wrong-daemon fallback the target
 * resolution promises never happens.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { getConfigPath, getMemhubHome } from '../paths.js';

/** Shape of the config file. Unknown keys (newer versions) pass through. */
export interface StoredConfig {
  readonly version: 1;
  /** Default remote daemon base URL; unset means "local daemon". */
  readonly base_url?: string | undefined;
  readonly [extra: string]: unknown;
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

function malformed(path: string, reason: string): Error {
  return new Error(
    `${path} is unreadable (${reason}) — delete it or rewrite it with: ` +
      'memhub config set base-url <url>'
  );
}

/** Read the config. A missing file is an empty config; a broken one throws. */
export function readConfig(home: string = getMemhubHome()): StoredConfig {
  const path = getConfigPath(home);
  if (!existsSync(path)) return { version: 1 };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    throw malformed(path, 'not valid JSON');
  }
  if (parsed.version !== 1) {
    throw malformed(path, `unsupported version ${String(parsed.version)}`);
  }
  const base = parsed.base_url;
  if (base !== undefined && (typeof base !== 'string' || base === '')) {
    throw malformed(path, 'base_url is not a non-empty string');
  }
  return { ...parsed, version: 1 } as StoredConfig;
}

/** Read one key's current value, or undefined when unset. */
export function getConfigValue(home: string, key: ConfigKey): string | undefined {
  const value = readConfig(home)[KEY_TO_FIELD[key]];
  return typeof value === 'string' ? value : undefined;
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
  const copy: Record<string, unknown> = { ...current };
  delete copy[field];
  const config = { ...copy, version: 1 } as StoredConfig;
  writeConfig(home, config);
  return config;
}
