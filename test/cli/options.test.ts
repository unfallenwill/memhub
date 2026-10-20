import { describe, expect, it } from 'vitest';
import {
  flagValue,
  flagValues,
  hasFlag,
  parseFlags,
  parsePortValue,
  requireValue,
  PORT_FLAG,
} from '../../src/cli/options.js';

describe('parsePortValue', () => {
  it('accepts a valid port', () => {
    expect(parsePortValue('1')).toBe(1);
    expect(parsePortValue('7800')).toBe(7800);
    expect(parsePortValue('65535')).toBe(65535);
  });

  it('rejects a port below the range', () => {
    expect(() => parsePortValue('0')).toThrow('invalid --port value: 0');
  });

  it('rejects a port above the range', () => {
    expect(() => parsePortValue('65536')).toThrow('invalid --port value: 65536');
  });

  it('rejects a value that is not a number', () => {
    expect(() => parsePortValue('abc')).toThrow('invalid --port value: abc');
  });

  it('rejects a missing value', () => {
    expect(() => parsePortValue(undefined)).toThrow('invalid --port value: (missing)');
  });
});

describe('requireValue', () => {
  it('returns the value', () => {
    expect(requireValue('--title', 'A title')).toBe('A title');
  });

  it('rejects a missing value', () => {
    expect(() => requireValue('--title', undefined)).toThrow('--title requires a value');
  });

  it('rejects an empty value', () => {
    expect(() => requireValue('--title', '')).toThrow('--title requires a value');
  });
});

describe('parseFlags', () => {
  const FLAGS = [
    { name: '--title', takesValue: true },
    { name: '--port', aliases: ['-p'], takesValue: true },
    { name: '--foreground', aliases: ['-f'] },
  ];

  it('collects the values of a flag', () => {
    const flags = parseFlags(['--title', 'T', '--port', '7900'], FLAGS);
    expect(flagValue(flags, '--title')).toBe('T');
    expect(flagValue(flags, '--port')).toBe('7900');
    expect(hasFlag(flags, '--foreground')).toBe(false);
  });

  it('understands the short form of a flag', () => {
    const flags = parseFlags(['-p', '7900', '-f'], FLAGS);
    expect(flagValue(flags, '--port')).toBe('7900');
    expect(hasFlag(flags, '--foreground')).toBe(true);
  });

  it('keeps every value of a repeated flag', () => {
    const flags = parseFlags(['--title', 'a', '--title', 'b'], FLAGS);
    expect(flagValues(flags, '--title')).toEqual(['a', 'b']);
    expect(flagValue(flags, '--title')).toBe('b');
  });

  it('reports a missing value as undefined', () => {
    const flags = parseFlags(['--title'], FLAGS);
    expect(hasFlag(flags, '--title')).toBe(true);
    expect(flagValue(flags, '--title')).toBeUndefined();
  });

  it('reports unknown arguments in the order they were typed', () => {
    const flags = parseFlags(['--title', 'T', '--nope', 'word'], FLAGS);
    expect(flags.entries.map(entry => entry.arg)).toEqual(['--title', '--nope', 'word']);
    expect(flags.entries[0]?.value).toBe('T');
    expect(flags.entries[1]?.name).toBeUndefined();
  });

  it('collects positionals only when the command allows them', () => {
    const flags = parseFlags(['q', 'extra'], FLAGS, { allowPositionals: true });
    expect(flags.positionals).toEqual(['q', 'extra']);
    expect(flags.entries.every(entry => entry.positional)).toBe(true);
  });

  it('treats an unknown argument as a flag when positionals are not allowed', () => {
    const flags = parseFlags(['word'], FLAGS);
    expect(flags.positionals).toEqual([]);
    expect(flags.entries[0]?.positional).toBe(false);
  });

  it('only treats the configured prefix as a flag', () => {
    const flags = parseFlags(['-x', 'q'], FLAGS, { allowPositionals: true, flagPrefix: '--' });
    expect(flags.positionals).toEqual(['-x', 'q']);
  });

  it('shares one port flag across the commands', () => {
    const flags = parseFlags(['-p', '1'], [PORT_FLAG]);
    expect(flagValue(flags, '--port')).toBe('1');
  });
});
