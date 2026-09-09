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

  it('serializes concurrent bundle writes instead of losing one to an exclusive transaction lock', async () => {
    const db = new InMemoryTileDb();
    const originalUpsert = db.upsertMany.bind(db);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let beganFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      beganFirst = resolve;
    });
    let writes = 0;
    let locked = false;
    db.upsertMany = async (...args) => {
      writes++;
      if (locked) throw new Error('database is locked');
      locked = true;
      if (writes === 1) {
        beganFirst();
        await firstGate;
      }
      await originalUpsert(...args);
      locked = false;
    };
    const store = createTileByteStore({ openDb: async () => db });
    const first = store.putMany('planet-v1', [{ tile: T1, bytes: bytesOf(3) }], 1);
    await firstStarted;
    const second = store.putMany('planet-v1', [{ tile: T2, bytes: bytesOf(4) }], 2);
    await Promise.resolve();
    await Promise.resolve();
    expect(writes).toBe(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(writes).toBe(2);
    expect((await db.get('planet-v1', T1))?.bytes).toEqual(bytesOf(3));
    expect((await db.get('planet-v1', T2))?.bytes).toEqual(bytesOf(4));
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
      expect(statements).toHaveLength(1);
      expect(statements[0].slice(1)).toEqual([
        'planet-v1',
        T1.z,
        T1.x,
        T1.y,
        bytesOf(3),
        3,
        1234,
        1234,
        'planet-v1',
        T2.z,
        T2.x,
        T2.y,
        null,
        0,
        1234,
        1234,
      ]);
    });

    it('persists all 256 z14 descendants in three statements within the portable bind limit', async () => {
      const statements: unknown[][] = [];
      const db = {
        runAsync: async (...args: unknown[]) => {
          statements.push(args);
          return { changes: 1 };
        },
      } as SqliteDb;
      const entries = Array.from({ length: 256 }, (_, i) => ({
        tile: { z: 14, x: 2624 + (i % 16), y: 5712 + Math.floor(i / 16) },
        bytes: i % 2 ? bytesOf(3, i) : null,
      }));
      await new SqliteTileDb(db).upsertMany('planet-v1', entries, 1234);
      expect(statements).toHaveLength(3);
      for (const [sql, ...params] of statements) {
        expect(params.length).toBeLessThanOrEqual(999);
        expect((sql as string).match(/\?/g)).toHaveLength(params.length);
      }
      expect(statements.flatMap((statement) => statement.slice(1))).toEqual(
        entries.flatMap(({ tile, bytes }) => [
          'planet-v1',
          tile.z,
          tile.x,
          tile.y,
          bytes,
          bytes?.byteLength ?? 0,
          1234,
          1234,
        ])
      );
    });

    it('does not open a transaction or execute SQL for an empty batch', async () => {
      const db = {
        withExclusiveTransactionAsync: jest.fn(),
        runAsync: jest.fn(),
      } as unknown as SqliteDb;
      await new SqliteTileDb(db).upsertMany('planet-v1', [], 1234);
      expect(db.withExclusiveTransactionAsync).not.toHaveBeenCalled();
      expect(db.runAsync).not.toHaveBeenCalled();
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

  it('a failed bundle write does not poison the queue for later writes', async () => {
    const db = new InMemoryTileDb();
    const upsert = jest
      .spyOn(db, 'upsertMany')
      .mockRejectedValueOnce(new Error('database is locked'));
    const store = createTileByteStore({ openDb: async () => db });

    await Promise.all([
      store.putMany('planet-v1', [{ tile: T1, bytes: bytesOf(3) }], 1),
      store.putMany('planet-v1', [{ tile: T2, bytes: bytesOf(4) }], 2),
    ]);

    expect(upsert).toHaveBeenCalledTimes(2);
    expect((await db.get('planet-v1', T2))?.bytes).toEqual(bytesOf(4));
  });
});
