import {
  createTileByteStore,
  InMemoryTileDb,
  SqliteTileDb,
  type SqliteDb,
  type TileDb,
} from '../sqlite-tile-store';
import type { TileCoord } from '../tile-math';

const T1: TileCoord = { z: 14, x: 1, y: 1 };
const T2: TileCoord = { z: 14, x: 2, y: 2 };
const T3: TileCoord = { z: 14, x: 3, y: 3 };

function bytesOf(n: number, fill = 7): Uint8Array {
  return new Uint8Array(n).fill(fill);
}

describe('createTileByteStore — roundtrip', () => {
  it('stores and returns bytes with their fetch time', async () => {
    const store = createTileByteStore({ openDb: async () => new InMemoryTileDb() });

    await store.putMany('planet-v1', [{ tile: T1, bytes: bytesOf(3) }], 1234);
    const hit = await store.get('planet-v1', T1);

    expect(hit).not.toBeNull();
    expect(hit!.bytes).toEqual(bytesOf(3));
    expect(hit!.fetchedAt).toBe(1234);
  });

  it('roundtrips null bytes (known-empty tile) distinctly from a miss', async () => {
    const store = createTileByteStore({ openDb: async () => new InMemoryTileDb() });

    await store.putMany('planet-v1', [{ tile: T1, bytes: null }], 1234);

    const empty = await store.get('planet-v1', T1);
    expect(empty).toEqual({ bytes: null, fetchedAt: 1234 });

    const miss = await store.get('planet-v1', T2);
    expect(miss).toBeNull();
  });

  it('namespaces rows by sourceId', async () => {
    const store = createTileByteStore({ openDb: async () => new InMemoryTileDb() });

    await store.putMany('planet-v1', [{ tile: T1, bytes: bytesOf(3) }], 1);

    expect(await store.get('planet-v2', T1)).toBeNull();
  });
});

describe('createTileByteStore — eviction', () => {
  it('evicts least-recently-used rows once the byte cap is exceeded', async () => {
    let now = 1000;
    const store = createTileByteStore({
      openDb: async () => new InMemoryTileDb(),
      maxBytes: 25,
      now: () => now,
    });

    await store.putMany('planet-v1', [{ tile: T1, bytes: bytesOf(10) }], 1000);
    now = 2000;
    await store.putMany('planet-v1', [{ tile: T2, bytes: bytesOf(10) }], 2000);
    now = 3000;
    // 30 bytes total > 25 cap → T1 (oldest) goes, T2+T3 stay.
    await store.putMany('planet-v1', [{ tile: T3, bytes: bytesOf(10) }], 3000);

    expect(await store.get('planet-v1', T1)).toBeNull();
    expect(await store.get('planet-v1', T2)).not.toBeNull();
    expect(await store.get('planet-v1', T3)).not.toBeNull();
  });

  it('zero-size (empty) rows do not stall eviction', async () => {
    const db = new InMemoryTileDb();
    const store = createTileByteStore({ openDb: async () => db, maxBytes: 15, now: () => 0 });

    // Oldest rows are empties; the loop must evict through them to free bytes.
    await store.putMany('planet-v1', [{ tile: T1, bytes: null }], 1);
    await store.putMany('planet-v1', [{ tile: T2, bytes: bytesOf(10) }], 2);
    await store.putMany('planet-v1', [{ tile: T3, bytes: bytesOf(10) }], 3);

    expect(await db.totalBytes()).toBeLessThanOrEqual(15);
    expect(await store.get('planet-v1', T3)).not.toBeNull(); // newest survives
  });
});

describe('createTileByteStore — degradation', () => {
  it('openDb resolving null falls back to a working in-memory store', async () => {
    const store = createTileByteStore({ openDb: async () => null });

    await store.putMany('planet-v1', [{ tile: T1, bytes: bytesOf(3) }], 1);

    expect((await store.get('planet-v1', T1))?.bytes).toEqual(bytesOf(3));
  });

  describe('SqliteTileDb', () => {
    it('writes a bundle inside one exclusive transaction', async () => {
      const statements: unknown[][] = [];
      let transactions = 0;
      const transaction = {
        runAsync: async (...args: unknown[]) => {
          statements.push(args);
          return { changes: 1 };
        },
      };
      const db = {
        withExclusiveTransactionAsync: async (
          task: (value: Pick<SqliteDb, 'runAsync'>) => Promise<void>
        ) => {
          transactions++;
          await task(transaction as Pick<SqliteDb, 'runAsync'>);
        },
      } as SqliteDb;

      await new SqliteTileDb(db).upsertMany(
        'planet-v1',
        [
          { tile: T1, bytes: bytesOf(3) },
          { tile: T2, bytes: null },
        ],
        1234
      );

      expect(transactions).toBe(1);
      expect(statements).toHaveLength(2);
    });
  });

  it('openDb throwing falls back to a working in-memory store', async () => {
    const store = createTileByteStore({
      openDb: async () => {
        throw new Error('no native module');
      },
    });

    await store.putMany('planet-v1', [{ tile: T1, bytes: bytesOf(3) }], 1);

    expect((await store.get('planet-v1', T1))?.bytes).toEqual(bytesOf(3));
  });

  it('a throwing db degrades writes and reads to the shared in-memory fallback', async () => {
    const broken: TileDb = {
      get: () => Promise.reject(new Error('io')),
      touch: () => Promise.reject(new Error('io')),
      upsertMany: () => Promise.reject(new Error('io')),
      totalBytes: () => Promise.reject(new Error('io')),
      evictOldest: () => Promise.reject(new Error('io')),
    };
    const store = createTileByteStore({ openDb: async () => broken });

    await expect(
      store.putMany('planet-v1', [{ tile: T1, bytes: bytesOf(3) }], 1)
    ).resolves.toBeUndefined();

    // The failed write landed in the fallback; the failed read finds it there.
    expect((await store.get('planet-v1', T1))?.bytes).toEqual(bytesOf(3));
    // Rows the fallback never saw are plain misses, not rejections.
    expect(await store.get('planet-v1', T2)).toBeNull();
  });
});
