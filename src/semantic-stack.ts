/**
 * The optional semantic stack.
 *
 * Semantic search is powered by two heavy optional packages
 * (@huggingface/transformers with its ONNX runtime, and @lancedb/lancedb
 * with its native binaries). They are optional peer dependencies so a
 * plain `npm install memhub` stays small; without them the daemon runs
 * in keyword-only mode. Both packages are only ever imported lazily via
 * dynamic `import()`, so the CLI and daemon start regardless.
 */

/** The npm packages that make up the semantic stack. */
export const SEMANTIC_PACKAGES = ['@huggingface/transformers', '@lancedb/lancedb'] as const;

/** How to install the semantic stack next to memhub. */
export const SEMANTIC_INSTALL_HINT =
  'Semantic search needs the optional packages @huggingface/transformers and ' +
  '@lancedb/lancedb, which are not installed. Install them next to memhub, e.g. ' +
  '`npm install @huggingface/transformers @lancedb/lancedb`, then restart the daemon.';

/**
 * Whether an error is a missing-module failure from a dynamic import.
 * Used to tell "the semantic stack is not installed" (permanent, do not
 * retry) apart from transient startup failures (offline, locked files).
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
