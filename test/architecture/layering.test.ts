/**
 * Architecture tests.
 *
 * Two things are guarded here:
 *
 *   1. the public API of the package (src/index.ts) still exposes every
 *      symbol consumers rely on, including the types that moved from
 *      src/db/types.ts into the pure domain layer,
 *   2. the layer boundaries hold: scripts/check-layers.mjs has to pass.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, expectTypeOf, it } from 'vitest';

import * as publicApi from '../../src/index.js';
import type {
  ActivityEntry,
  ActivityPage,
  AdminAuthRecord,
  CardRecord,
  CardStats,
  DeviceTokenRecord,
  EventRow,
  QueueStats,
} from '../../src/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const checker = path.join(repoRoot, 'scripts', 'check-layers.mjs');

/** Run the layer checker and return its output plus its exit code. */
function runChecker(args: readonly string[] = []): { code: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [checker, ...args], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      code: failure.status ?? 1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

describe('public API', () => {
  it('exposes the runtime values consumers import', () => {
    // The tokenizer of the keyword backend.
    expect(typeof publicApi.tokenize).toBe('function');
    expect(publicApi.tokenize('Hello MemHub')).toEqual(['hello', 'memhub']);

    // The card serializer of the HTTP adapter.
    expect(typeof publicApi.serializeCard).toBe('function');

    // The domain constants.
    expect(publicApi.CARD_TYPES).toEqual(['fact', 'preference', 'decision', 'insight', 'pattern']);
    expect(publicApi.CARD_STATUSES).toEqual([
      'active',
      'archived',
      'merged',
      'rejected',
      'superseded',
    ]);
    expect(publicApi.SEARCH_MODES).toEqual(['auto', 'semantic', 'keyword']);
  });

  it('exposes the device token store that src/db/index.ts re-exports', () => {
    expect(typeof publicApi.tokenHash).toBe('function');
    expect(typeof publicApi.DeviceTokenStore).toBe('function');
    expect(publicApi.tokenHash('token')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('exposes the types that moved from src/db/types.ts to the core layer', () => {
    // Type level assertions: they are checked by `vitest --typecheck` and
    // by the editor, the runtime checks below keep the file honest.
    expectTypeOf<CardRecord>().toHaveProperty('id');
    expectTypeOf<ActivityEntry>().toHaveProperty('action');
    expectTypeOf<ActivityPage>().toHaveProperty('entries');
    expectTypeOf<QueueStats>().toHaveProperty('pendingEvents');
    expectTypeOf<EventRow>().toHaveProperty('processedAt');
    expectTypeOf<DeviceTokenRecord>().toHaveProperty('tokenHash');
    expectTypeOf<AdminAuthRecord>().toHaveProperty('passwordHash');
    expectTypeOf<CardStats>().toHaveProperty('pendingIndex');
  });

  it('keeps the runtime values of the moved types reachable', () => {
    // CARD_TYPES / CARD_STATUSES / SEARCH_MODES are the runtime twins of
    // the moved types; if the re-export chain breaks, they disappear here.
    expect(publicApi.CARD_TYPES).toContain('fact');
    expect(publicApi.CARD_STATUSES).toContain('active');
    expect(publicApi.SEARCH_MODES).toContain('auto');
  });
});

describe('layer boundaries', () => {
  it('passes the layer checker', () => {
    const { code, output } = runChecker();
    expect(output).toContain('check-layers: OK');
    expect(code).toBe(0);
  });

  it('has no dependency cycle between the layers', () => {
    const { code, output } = runChecker();
    expect(output).not.toContain('dependency cycle');
    expect(code).toBe(0);
  });

  it('has no known deviation from the target architecture', () => {
    const { code, output } = runChecker();
    // Every deviation the refactor started with is closed, so nothing is
    // deferred any more: the KNOWN_DEVIATIONS table of
    // scripts/check-layers.mjs is empty and the strict mode passes too.
    expect(output).not.toContain('known deviation');
    expect(code).toBe(0);

    const strict = runChecker(['--strict']);
    expect(strict.output).not.toContain('violation(s) found');
    expect(strict.code).toBe(0);
  });
});

describe('the command registry', () => {
  it('is not imported by the command modules it loads', () => {
    // The registry loads the command modules lazily; a command that
    // imported the registry would close a cycle. The shared contract
    // lives in src/cli/types.js, so the two sides never import each
    // other - not even as a type.
    const commandsDir = path.join(repoRoot, 'src', 'cli', 'commands');
    const files = fs.readdirSync(commandsDir).filter(name => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = fs.readFileSync(path.join(commandsDir, file), 'utf-8');
      expect(source, file).not.toContain("from '../registry.js'");
    }
  });
});

describe('the public API surface', () => {
  /**
   * The exported names of a module, resolved by the TypeScript compiler.
   *
   * A plain `import { X } from '../../src/index.js'` would be erased by
   * the transpiler, so a missing type export would not fail the test
   * run. The compiler API sees the real export table.
   */
  function exportTable(files: readonly string[]): (file: string) => Set<string> {
    const configFile = ts.readConfigFile(path.join(repoRoot, 'tsconfig.json'), ts.sys.readFile);
    if (configFile.error !== undefined) {
      throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
    }
    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repoRoot);
    const program = ts.createProgram(
      files.map(file => path.join(repoRoot, file)),
      { ...parsed.options, noEmit: true }
    );
    const checker = program.getTypeChecker();
    return file => {
      const source = program.getSourceFile(path.join(repoRoot, file));
      if (source === undefined) throw new Error(`cannot load ${file}`);
      const moduleSymbol = checker.getSymbolAtLocation(source);
      if (moduleSymbol === undefined) throw new Error(`${file} is not a module`);
      return new Set(checker.getExportsOfModule(moduleSymbol).map(symbol => symbol.getName()));
    };
  }

  it('re-exports every name of the core domain types', () => {
    const exportsOf = exportTable(['src/index.ts', 'src/core/domain/types.ts']);
    const barrel = exportsOf('src/index.ts');
    const domain = exportsOf('src/core/domain/types.ts');

    const missing = [...domain].filter(name => !barrel.has(name));
    expect(missing).toEqual([]);
    // The domain types are not empty - the assertion above would be
    // vacuous otherwise.
    expect(domain.size).toBeGreaterThan(10);
  });

  it('still exposes the tokenizer and the card serializer', () => {
    const exportsOf = exportTable(['src/index.ts']);
    const barrel = exportsOf('src/index.ts');
    expect(barrel.has('tokenize')).toBe(true);
    expect(barrel.has('serializeCard')).toBe(true);
  });
});
