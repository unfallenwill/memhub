/**
 * `memhub reindex` command.
 *
 * Rebuilds the LanceDB vector index from the SQLite source of truth.
 * Useful after switching embedding models manually or when the vector
 * store was corrupted. Works offline; stop the daemon first if possible
 * (both processes writing the same LanceDB directory is not supported).
 */

import { existsSync } from 'fs';
import { openDatabase } from '../db/database.js';
import type { EmbeddingProvider } from '../embedding/embedder.js';
import { TransformersEmbedder } from '../embedding/transformers-embedder.js';
import { getDatabasePath, getLanceDbPath, getMemhubHome, getModelsDir } from '../paths.js';
import { isModuleNotFound, SEMANTIC_INSTALL_HINT } from '../semantic-stack.js';
import type { CardVectorStore } from '../storage/vector-index.js';
import { LanceVectorIndex } from '../storage/vector-index.js';
import { rebuildVectorIndex } from '../worker/rebuild.js';

/** Options for the reindex command. */
export interface ReindexCommandOptions {
  /** Data directory override (defaults to the resolved MemHub home). */
  readonly home?: string | undefined;
  /** Embedding provider override (tests inject fakes here). */
  readonly embedder?: EmbeddingProvider | undefined;
  /** Vector store override (tests inject fakes here). */
  readonly vectors?: CardVectorStore | undefined;
}

/** Run the reindex command. Returns the process exit code. */
export async function runReindexCommand(options: ReindexCommandOptions = {}): Promise<number> {
  const home = options.home ?? getMemhubHome();
  const dbPath = getDatabasePath(home);
  if (!existsSync(dbPath)) {
    console.error(`No MemHub database found at ${dbPath}. Start the server first.`);
    return 1;
  }

  const embedder = options.embedder ?? new TransformersEmbedder({ cacheDir: getModelsDir(home) });
  const vectors = options.vectors ?? new LanceVectorIndex(getLanceDbPath(home));
  const db = openDatabase(dbPath);

  console.log(`Rebuilding the vector index (model: ${embedder.modelId})...`);
  try {
    // Load the model up front so a missing semantic stack fails here with
    // the install hint instead of silently failing every batch below.
    await embedder.ensureLoaded();
    const result = await rebuildVectorIndex({
      db,
      embedder,
      vectors,
      onProgress: (done, total) => {
        console.log(`  indexed ${done}/${total} cards`);
      },
    });
    if (result.failed > 0) {
      console.error(
        `Reindexed ${result.indexed} cards; ${result.failed} failed and stay unindexed ` +
          `(the hourly compensation scan will retry them).`
      );
      return 1;
    }
    console.log(`Reindexed ${result.indexed} cards into the vector index.`);
    return 0;
  } catch (error) {
    if (isModuleNotFound(error)) {
      console.error('Reindex failed: the semantic stack is not installed.');
      console.error(SEMANTIC_INSTALL_HINT);
      return 1;
    }
    console.error(`Reindex failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    db.close();
  }
}
