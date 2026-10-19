/**
 * The optional semantic stack.
 *
 * Semantic search is powered by two heavy optional packages
 * (@huggingface/transformers with its ONNX runtime, and @lancedb/lancedb
 * with its native binaries). They are optional peer dependencies so a
 * plain `npm install memhub` stays small; without them the daemon runs
 * in keyword-only mode. Both packages are only ever imported lazily via
 * dynamic `import()`, so the CLI and daemon start regardless.
 *
 * This module is the single source of truth for *which* packages make up
 * the semantic stack, for the install hint and for the "which package is
 * missing?" classification. src/embedding/registry.ts derives its
 * provider metadata from SEMANTIC_PACKAGES and re-exports
 * missingSemanticPackage() for backwards compatibility.
 */

/** The npm packages that make up the semantic stack. */
export const SEMANTIC_PACKAGES = ['@huggingface/transformers', '@lancedb/lancedb'] as const;

/** One of the packages that make up the semantic stack. */
export type SemanticStackPackage = (typeof SEMANTIC_PACKAGES)[number];

/**
 * Format a list of package names for a human-readable sentence.
 * "a", "a and b", "a, b and c".
 */
function formatPackageList(packages: readonly string[]): string {
  if (packages.length <= 1) return packages.join('');
  if (packages.length === 2) return `${packages[0]} and ${packages[1]}`;
  return `${packages.slice(0, -1).join(', ')} and ${packages[packages.length - 1]}`;
}

/**
 * Build the install hint for the given missing package(s).
 *
 * Only the packages that are actually missing are named, so a user who
 * only lacks the vector store is not told to install the embedding
 * runtime as well. An empty list means "the whole stack is missing".
 *
 * The wording is part of the public API surface: the error code
 * (semantic_not_installed) and the HTTP status (501) stay the same, only
 * this message changes.
 */
export function semanticInstallHint(
  missing: SemanticStackPackage | readonly SemanticStackPackage[]
): string {
  const packages = (typeof missing === 'string' ? [missing] : [...missing]).filter(pkg =>
    SEMANTIC_PACKAGES.includes(pkg)
  );
  const targets = packages.length > 0 ? packages : [...SEMANTIC_PACKAGES];
  if (targets.length === 1) {
    const only = targets[0];
    return (
      `Semantic search needs the optional package ${only}, which is not installed. ` +
      `Install it next to memhub, e.g. \`npm install ${only}\`, then restart the daemon.`
    );
  }
  return (
    `Semantic search needs the optional packages ${formatPackageList(targets)}, ` +
    `which are not installed. Install them next to memhub, e.g. ` +
    `\`npm install ${targets.join(' ')}\`, then restart the daemon.`
  );
}

/** How to install the semantic stack next to memhub. */
export const SEMANTIC_INSTALL_HINT = semanticInstallHint(SEMANTIC_PACKAGES);

/**
 * Whether an error is a missing-module failure from a dynamic import.
 *
 * @deprecated This predicate is deliberately coarse: it answers "did a
 * module fail to resolve?", not "is one of *our* packages missing?". A
 * user plugin whose own import fails is misclassified as a missing
 * semantic stack, which permanently disables semantic search instead of
 * retrying. Use missingSemanticPackage(), which names the missing
 * package and returns null for unrelated errors.
 * Kept as-is for backwards compatibility.
 */
export function isModuleNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === 'ERR_MODULE_NOT_FOUND' ||
    code === 'MODULE_NOT_FOUND' ||
    error.message.includes('Cannot find package')
  );
}

/** Error codes Node uses for a failed module resolution. */
const MODULE_NOT_FOUND_CODES: readonly string[] = ['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'];

/**
 * Matches the "cannot find package|module '<specifier>'" wording used by
 * Node (ESM and CJS) and by bundlers ("can't resolve '<specifier>'").
 */
const MODULE_FAILURE_PATTERN = /(?:cannot|can't)\s+(?:find|resolve)\s+(?:package|module)\b/i;

/** Same as MODULE_FAILURE_PATTERN, but captures the missing specifier. */
const MISSING_SPECIFIER_PATTERN =
  /(?:cannot|can't)\s+(?:find|resolve)\s+(?:package|module)\s+['"`]?([^'"`\s]+)/gi;

/** Whether a string looks like a bare module specifier (not a path). */
function isBareSpecifier(specifier: string): boolean {
  return (
    !specifier.startsWith('.') &&
    !specifier.startsWith('/') &&
    !specifier.startsWith('\\') &&
    !specifier.includes('://') &&
    !specifier.startsWith('node:') &&
    !/^[a-zA-Z]:[\\/]/.test(specifier)
  );
}

/** The semantic package a specifier belongs to, if any. */
function matchSemanticPackage(specifier: string): SemanticStackPackage | null {
  const cleaned = specifier.replace(/[.,;)]+$/, '');
  for (const pkg of SEMANTIC_PACKAGES) {
    if (cleaned === pkg || cleaned.startsWith(`${pkg}/`)) return pkg;
  }
  return null;
}

/**
 * Which semantic package is missing, if any.
 *
 * Unlike the coarse isModuleNotFound() predicate, this only reports a
 * package when the *missing specifier* is one of the semantic packages.
 * An import failure of some other package (a user plugin, a transitive
 * dependency) returns null, i.e. "unknown failure - retryable", so it
 * never disables semantic search permanently by accident.
 */
export function missingSemanticPackage(error: unknown): SemanticStackPackage | null {
  if (!(error instanceof Error)) return null;
  const code = (error as NodeJS.ErrnoException).code;
  const message = error.message;
  const isModuleFailure =
    (code !== undefined && MODULE_NOT_FOUND_CODES.includes(code)) ||
    MODULE_FAILURE_PATTERN.test(message);
  if (!isModuleFailure) return null;

  const candidates: string[] = [];
  for (const match of message.matchAll(MISSING_SPECIFIER_PATTERN)) {
    candidates.push(match[1]);
  }
  const url = (error as { url?: unknown }).url;
  if (typeof url === 'string' && isBareSpecifier(url)) {
    candidates.push(url);
  }

  for (const candidate of candidates) {
    const pkg = matchSemanticPackage(candidate);
    if (pkg !== null) return pkg;
  }
  return null;
}
