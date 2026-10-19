#!/usr/bin/env node
/**
 * MemHub layer boundary checker.
 *
 * Turns the layering rules from AGENTS.md / docs/architecture.md into an
 * executable check. It uses the TypeScript compiler API (already a
 * devDependency) to parse every file under `src/`, resolves every
 * project-internal import to its real file (so `.js` specifiers that point
 * at `.ts` sources are handled), maps the files onto layers and then
 * checks:
 *
 *   1. every project-internal import stays inside the layer whitelist,
 *   2. the layer dependency graph is acyclic,
 *   3. bare package specifiers stay inside the per-layer package
 *      whitelist (in particular `node:sqlite` only in `src/db` and
 *      `src/runtime`).
 *
 * Usage:
 *   node scripts/check-layers.mjs            # check, non-zero exit on error
 *   node scripts/check-layers.mjs --graph    # also print the layer graph
 *   node scripts/check-layers.mjs --strict   # also fail on known deviations
 *
 * Exit codes: 0 = no violations, 1 = violations found, 2 = the checker
 * itself failed (bad configuration, unreadable sources, ...).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';

import ts from 'typescript';

/** Normalize a path to the posix form used for reporting and comparisons. */
const toPosix = value => value.split(path.sep).join('/');

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = toPosix(path.resolve(scriptDir, '..'));
/** The TypeScript compiler reports posix-style file names on Windows. */
const srcDir = `${rootDir}/src`;

/** All layers the checker knows about (a directory directly under src/). */
const ALL_LAYERS = [
  'auth',
  'cli',
  'config',
  'core',
  'daemon',
  'db',
  'embedding',
  'http',
  'runtime',
  'services',
  'storage',
  'worker',
];

/**
 * The target dependency matrix.
 *
 * `layer -> layers it is allowed to import from`.
 *
 * `root` is the pseudo layer of the files that live directly in `src/`
 * (the legacy compatibility shims `paths.ts`, `semantic-stack.ts` and
 * `version.ts`). It is importable from every layer because those shims
 * are the shared compatibility surface, but it may only reach into other
 * layers through the shims themselves.
 */
const ALLOWED_LAYERS = {
  core: ['core'],
  config: ['core'],
  db: ['core', 'config'],
  auth: ['core', 'config', 'db'],
  embedding: ['core', 'root'],
  storage: ['core', 'embedding', 'root'],
  services: ['core', 'config', 'db', 'auth', 'root'],
  worker: ['core', 'config', 'db', 'services', 'embedding', 'storage', 'root'],
  http: ['core', 'config', 'db', 'auth', 'services', 'root'],
  runtime: ['core', 'config', 'db', 'auth', 'services', 'worker', 'embedding', 'storage', 'root'],
  daemon: [...ALL_LAYERS, 'root'],
  cli: [...ALL_LAYERS, 'root'],
  root: [...ALL_LAYERS, 'root'],
};

/**
 * Third-party packages a layer may import.
 *
 * Node builtins other than `node:sqlite` are treated as the standard
 * library and are allowed everywhere; `core` is the exception, it must
 * stay free of runtime dependencies. `node:sqlite` is not listed here, it
 * is restricted by RESTRICTED_BUILTINS below.
 */
const ALLOWED_PACKAGES = {
  core: [],
  config: [],
  db: [],
  auth: [],
  embedding: ['@huggingface/transformers'],
  storage: ['@lancedb/lancedb'],
  services: [],
  worker: [],
  http: ['hono', 'zod'],
  runtime: [],
  daemon: ['hono', '@hono/node-server'],
  cli: [],
  root: [],
};

/**
 * Files that are part of the public API surface and therefore exempt from
 * the layer graph: `src/index.ts` only re-exports other layers, so it can
 * never be part of a cycle and no layer may import it (that would be a
 * cycle).
 */
const GRAPH_EXEMPT = new Set([`${srcDir}/index.ts`]);

/** Node builtins that are only allowed in dedicated layers. */
const RESTRICTED_BUILTINS = {
  'node:sqlite': new Set(['db', 'runtime']),
};

/** Every Node builtin module name, with and without the `node:` prefix. */
const BUILTIN_MODULES = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)]);

/**
 * Known deviations from the target architecture.
 *
 * The list is empty: the refactor closed every deviation it started
 * with, so the target architecture is the architecture. The mechanism
 * stays, because it is how a deviation is made visible before it is
 * fixed:
 *
 *   - a deviation listed here is reported as a warning, not a failure,
 *   - any deviation that is NOT listed here fails the check,
 *   - `--strict` turns the listed deviations into failures as well, so
 *     that `--strict` is the gate that says "nothing is deferred".
 *
 * Every entry must name the file, the forbidden target and the reason.
 * A new entry is a promise to fix it; leaving one behind after the fix
 * would silently defer the next violation of the same shape.
 */
const KNOWN_DEVIATIONS = [];

/** Collect every .ts file below `dir` (posix paths). */
function collectTsFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Map a file to its layer: the first directory segment below `src/`.
 * Files directly in `src/` belong to the pseudo layer `root`.
 */
function layerOf(file) {
  const relative = file.slice(srcDir.length + 1);
  const segments = relative.split('/');
  return segments.length > 1 ? segments[0] : 'root';
}

/** Normalize an absolute path to the repo-relative form used for reporting. */
function display(file) {
  return file.startsWith(`${rootDir}/`) ? file.slice(rootDir.length + 1) : file;
}

function fail(message) {
  process.stderr.write(`check-layers: ${message}\n`);
  process.exit(2);
}

if (!fs.existsSync(srcDir)) {
  fail(`source directory not found: ${srcDir}`);
}

const tsconfigPath = `${rootDir}/tsconfig.json`;
if (!fs.existsSync(tsconfigPath)) {
  fail(`tsconfig not found: ${tsconfigPath}`);
}

const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
if (configFile.error) {
  fail(
    `cannot read ${display(tsconfigPath)}: ${ts.flattenDiagnosticMessageText(
      configFile.error.messageText,
      '\n'
    )}`
  );
}

const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, rootDir);
const compilerOptions = { ...parsed.options, noEmit: true };

const sourceFiles = collectTsFiles(srcDir);
const program = ts.createProgram(sourceFiles, compilerOptions);

/** @type {Array<{file: string, layer: string, line: number, spec: string, kind: string, target: string|null, targetLayer?: string}>} */
const edges = [];
const violations = [];

function report(file, line, message, target) {
  violations.push({ file: display(file), line, message, target: target ?? null });
}

/** Walk the AST of one source file and collect its import edges. */
function collectEdges(sourceFile) {
  const from = layerOf(sourceFile.fileName);
  const visit = node => {
    let specifier = null;
    let kind = '';

    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specifier = node.moduleSpecifier.text;
        kind = ts.isImportDeclaration(node)
          ? node.importClause?.isTypeOnly
            ? 'import-type'
            : 'import'
          : node.isTypeOnly
            ? 'export-type'
            : 'export';
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifier = node.arguments[0].text;
      kind = 'dynamic-import';
    }

    if (specifier !== null) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      edges.push({
        file: sourceFile.fileName,
        layer: from,
        line: position.line + 1,
        spec: specifier,
        kind,
        target: null,
      });
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

for (const sourceFile of program.getSourceFiles()) {
  const fileName = toPosix(sourceFile.fileName);
  if (!fileName.startsWith(`${srcDir}/`)) continue;
  if (GRAPH_EXEMPT.has(fileName)) continue;
  collectEdges(sourceFile);
}

// Resolve every relative specifier to the file it really points at.
for (const edge of edges) {
  if (!edge.spec.startsWith('.')) continue;
  const resolution = ts.resolveModuleName(
    edge.spec,
    edge.file,
    compilerOptions,
    ts.sys
  ).resolvedModule;
  if (!resolution) {
    report(edge.file, edge.line, `cannot resolve import "${edge.spec}"`);
    continue;
  }
  const resolved = toPosix(path.resolve(resolution.resolvedFileName));
  if (!resolved.startsWith(`${srcDir}/`)) {
    // A relative import that leaves src/ - not a layer problem, but it is
    // worth reporting because the layering assumes everything is in src/.
    report(edge.file, edge.line, `relative import "${edge.spec}" escapes src/`);
    continue;
  }
  edge.target = resolved;
  edge.targetLayer = layerOf(resolved);
}

// ---------------------------------------------------------------------------
// 1. layer whitelist
// ---------------------------------------------------------------------------
for (const edge of edges) {
  if (!edge.target) continue;
  const allowed = ALLOWED_LAYERS[edge.layer];
  if (!allowed) {
    report(edge.file, edge.line, `unknown source layer "${edge.layer}"`);
    continue;
  }
  if (!allowed.includes(edge.targetLayer) && edge.targetLayer !== edge.layer) {
    report(
      edge.file,
      edge.line,
      `layer "${edge.layer}" may not import layer "${edge.targetLayer}" ` +
        `("${edge.spec}" -> ${display(edge.target)}); allowed: ${allowed.join(', ')}`,
      display(edge.target)
    );
  }
}

// ---------------------------------------------------------------------------
// 2. bare package whitelist
// ---------------------------------------------------------------------------
function packageOf(specifier) {
  if (specifier.startsWith('node:')) return specifier;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

for (const edge of edges) {
  if (edge.spec.startsWith('.')) continue;
  const pkg = packageOf(edge.spec);
  const layer = edge.layer;

  const restricted = RESTRICTED_BUILTINS[pkg];
  if (restricted) {
    if (!restricted.has(layer)) {
      report(
        edge.file,
        edge.line,
        `"${pkg}" may only be imported from ${[...restricted]
          .map(name => `src/${name}`)
          .join(' or ')} (layer "${layer}")`,
        pkg
      );
    }
    continue;
  }

  // Node builtins (other than the restricted ones) are the standard
  // library: they are allowed in every layer, except in `core`, which
  // must stay free of runtime dependencies.
  if (pkg.startsWith('node:') || BUILTIN_MODULES.has(pkg)) {
    if (layer === 'core') {
      report(
        edge.file,
        edge.line,
        `layer "core" must not depend on the runtime package "${pkg}"`,
        pkg
      );
    }
    continue;
  }

  const allowed = ALLOWED_PACKAGES[layer];
  if (!allowed) {
    report(edge.file, edge.line, `unknown source layer "${layer}"`);
    continue;
  }
  if (!allowed.includes(pkg)) {
    report(
      edge.file,
      edge.line,
      `layer "${layer}" may not import the package "${pkg}"; allowed: ` +
        (allowed.length > 0 ? allowed.join(', ') : '(none)')
    );
  }
}

// ---------------------------------------------------------------------------
// 3. cycles between layers
// ---------------------------------------------------------------------------
const graph = new Map();
for (const edge of edges) {
  if (!edge.target) continue;
  if (!graph.has(edge.layer)) graph.set(edge.layer, new Set());
  // A layer importing its own files is normal, not a cycle.
  if (edge.targetLayer === edge.layer) continue;
  graph.get(edge.layer).add(edge.targetLayer);
}

/** Depth-first search that reports every cycle it can reach. */
function findCycles() {
  const cycles = [];
  const state = new Map(); // 0 = unvisited, 1 = on stack, 2 = done
  const stack = [];

  const visit = node => {
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const status = state.get(next) ?? 0;
      if (status === 0) {
        visit(next);
      } else if (status === 1) {
        const start = stack.indexOf(next);
        cycles.push(stack.slice(start).concat(next));
      }
    }
    stack.pop();
    state.set(node, 2);
  };

  for (const node of graph.keys()) {
    if ((state.get(node) ?? 0) === 0) visit(node);
  }
  return cycles;
}

for (const cycle of findCycles()) {
  // Report the cycle on the first file that takes part in it.
  const [from, ...rest] = cycle;
  const edge = edges.find(
    candidate => candidate.layer === from && candidate.targetLayer === rest[0]
  );
  report(
    edge?.file ?? `${srcDir}/${from}`,
    edge?.line ?? 1,
    `dependency cycle between layers: ${cycle.join(' -> ')}`
  );
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
if (process.argv.includes('--graph')) {
  process.stdout.write('layer graph:\n');
  for (const [layer, targets] of [...graph].sort()) {
    process.stdout.write(`  ${layer.padEnd(10)} -> ${[...targets].sort().join(', ')}\n`);
  }
  process.stdout.write('\n');
}

const strict = process.argv.includes('--strict');

/** Split the violations into "known deviation" and "new violation". */
const deferred = [];
const errors = [];
for (const violation of violations) {
  const known = KNOWN_DEVIATIONS.find(
    deviation => deviation.from === violation.file && deviation.to === violation.target
  );
  if (known && !strict) {
    deferred.push({ ...violation, reason: known.reason });
  } else {
    errors.push(violation);
  }
}

if (deferred.length > 0) {
  process.stdout.write(
    `check-layers: ${deferred.length} known deviation(s) from the target architecture:\n`
  );
  for (const violation of deferred) {
    process.stdout.write(
      `  ${violation.file}:${violation.line}  ${violation.message}\n` +
        `      reason: ${violation.reason}\n`
    );
  }
  process.stdout.write('  (run with --strict to make these fail the check)\n');
}

if (errors.length === 0) {
  process.stdout.write(
    `check-layers: OK - ${edges.length} imports checked across ${graph.size} layers` +
      (deferred.length > 0 ? `, ${deferred.length} known deviation(s) deferred.` : '.') +
      '\n'
  );
  process.exit(0);
}

errors.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
process.stderr.write(`check-layers: ${errors.length} violation(s) found:\n`);
for (const violation of errors) {
  process.stderr.write(`  ${violation.file}:${violation.line}  ${violation.message}\n`);
}
process.exit(1);
