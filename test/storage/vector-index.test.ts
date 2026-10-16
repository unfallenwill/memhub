import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { LanceVectorIndex } from '../../src/storage/vector-index.js';

/**
 * These tests use the real LanceDB native module against a temporary
 * directory (no network, no models) to verify the storage layer for real.
 */
describe('LanceVectorIndex', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memhub-lance-'));
  const index = new LanceVectorIndex(join(dir, 'lancedb'));

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('returns no matches before anything was stored', async () => {
    const fresh = new LanceVectorIndex(join(dir, 'empty'));
    expect(await fresh.searchByVector([1, 0, 0], 5)).toEqual([]);
    expect(await fresh.searchByVector([1, 0, 0], 0)).toEqual([]);
  });

  it('stores vectors and finds nearest neighbours', async () => {
    await index.upsert(1, [1, 0, 0]);
    await index.upsert(2, [0, 1, 0]);
    await index.upsert(3, [0.9, 0.1, 0]);

    const matches = await index.searchByVector([1, 0, 0], 2);
    expect(matches.map(m => m.cardId)).toEqual([1, 3]);
    expect(matches[0].distance).toBeLessThan(matches[1].distance);
  });

  it('upserts are idempotent (delete + insert, no duplicates)', async () => {
    await index.upsert(1, [1, 0, 0]);
    await index.upsert(1, [1, 0, 0]);

    const matches = await index.searchByVector([1, 0, 0], 10);
    const cardOne = matches.filter(m => m.cardId === 1);
    expect(cardOne).toHaveLength(1);
    expect(cardOne[0].distance).toBeCloseTo(0, 5);
  });

  it('replaces the previous vector for the same card', async () => {
    await index.upsert(2, [0, 1, 0]);
    await index.upsert(2, [1, 0, 0]);

    const matches = await index.searchByVector([1, 0, 0], 10);
    const cardTwo = matches.filter(m => m.cardId === 2);
    expect(cardTwo).toHaveLength(1);
    expect(cardTwo[0].distance).toBeCloseTo(0, 5);
    // The old direction no longer matches well.
    const oldMatches = await index.searchByVector([0, 1, 0], 10);
    expect(oldMatches.find(m => m.cardId === 2)?.distance ?? 1).toBeGreaterThan(0.5);
  });

  it('clears all vectors', async () => {
    await index.clear();
    expect(await index.searchByVector([1, 0, 0], 10)).toEqual([]);

    // The store is usable again after a clear (table is recreated lazily).
    await index.upsert(7, [0.5, 0.5, 0]);
    const matches = await index.searchByVector([0.5, 0.5, 0], 5);
    expect(matches.map(m => m.cardId)).toEqual([7]);
  });

  it('initialization is idempotent', async () => {
    const other = new LanceVectorIndex(join(dir, 'lancedb'));
    await other.initialize();
    await other.initialize();
    const matches = await other.searchByVector([0.5, 0.5, 0], 5);
    expect(matches.map(m => m.cardId)).toEqual([7]);
  });

  it('retries initialization after a transient connect failure', async () => {
    const flaky = new LanceVectorIndex(join(dir, 'flakedb'));
    // Make the first connect() attempt fail, later ones succeed.
    const holder = flaky as unknown as { connect: () => Promise<void> };
    const originalConnect = holder.connect.bind(flaky);
    let calls = 0;
    holder.connect = async () => {
      calls++;
      if (calls === 1) throw new Error('transient lock');
      await originalConnect();
    };

    await expect(flaky.initialize()).rejects.toThrow('transient lock');
    // The rejection must not be cached: the next call initializes for real
    // and the store becomes usable.
    await flaky.upsert(9, [1, 0, 0]);
    expect((await flaky.searchByVector([1, 0, 0], 5)).map(m => m.cardId)).toEqual([9]);
    expect(calls).toBe(2);
  });
});
