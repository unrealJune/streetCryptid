import type { StoredTile, TileByteStore } from './tile-bytes';
import type { TileCoord } from './tile-math';

/**
 * Durable tile-byte store backing {@link BundleFetchByteSource}. Persistence is
 * part of the privacy contract, not just a perf win: a tile block already on
 * disk is never re-requested, so revisiting home ground is server-silent
 * across app restarts.
 *
 * Follows the lazy-native expo-sqlite pattern of social/net/persistence.ts:
 * the DB opens on first use and every access is guarded, so builds without the
 * native module (web, Expo Go) degrade to an in-memory store. The store logic
 * (LRU cap, last_used write-amp guard) lives against the narrow {@link TileDb}
 * port so tests exercise it with a fake instead of real SQL.
 */

const DB_NAME = 'streetcryptid.tiles.db';

/** Bounded storage for unpacked privacy bundles plus lightweight coarse planet tiles. */
export const TILE_STORE_MAX_BYTES = 128 * 1024 * 1024;

/** Reads only bump last_used when it's this stale, to keep read paths write-light. */
const TOUCH_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface TileRow {
  readonly bytes: Uint8Array | null;
  readonly fetchedAt: number;
  readonly lastUsed: number;
}

/** Minimal storage port the tile store runs on: SQLite in the app, a Map in tests. */
export interface TileDb {
  get(source: string, tile: TileCoord): Promise<TileRow | null>;
  touch(source: string, tile: TileCoord, lastUsed: number): Promise<void>;
  upsertMany(
    source: string,
    entries: readonly { tile: TileCoord; bytes: Uint8Array | null }[],
    fetchedAt: number
  ): Promise<void>;
  totalBytes(): Promise<number>;
  /** Delete up to `n` least-recently-used rows; resolves to how many were deleted. */
  evictOldest(n: number): Promise<number>;
}

export interface TileStoreOptions {
  readonly maxBytes?: number;
  /** Injectable opener for tests; `null` resolution → in-memory fallback. */
  readonly openDb?: () => Promise<TileDb | null>;
  readonly now?: () => number;
}

export function createTileByteStore(opts: TileStoreOptions = {}): TileByteStore {
  return new DbTileByteStore(
    opts.openDb ?? openSqliteTileDb,
    opts.maxBytes ?? TILE_STORE_MAX_BYTES,
    opts.now ?? Date.now
  );
}

class DbTileByteStore implements TileByteStore {
  private readonly fallback = new InMemoryTileDb();
  private dbPromise: Promise<TileDb | null> | undefined;

  constructor(
    private readonly openDb: () => Promise<TileDb | null>,
    private readonly maxBytes: number,
    private readonly now: () => number
  ) {}

  private db(): Promise<TileDb | null> {
    if (!this.dbPromise) this.dbPromise = this.openDb().catch(() => null);
    return this.dbPromise;
  }

  async get(sourceId: string, tile: TileCoord): Promise<StoredTile | null> {
    const db = (await this.db()) ?? this.fallback;
    let row: TileRow | null;
    try {
      row = await db.get(sourceId, tile);
    } catch {
      // Mirror putMany's degradation: a throwing db reads from the same
      // in-memory rows its failed writes landed in.
      row = await this.fallback.get(sourceId, tile);
    }
    if (!row) return null;
    const now = this.now();
    if (now - row.lastUsed > TOUCH_INTERVAL_MS) {
      try {
        await db.touch(sourceId, tile, now);
      } catch {
        // touch is best-effort; losing LRU freshness never loses data
      }
    }
    return { bytes: row.bytes, fetchedAt: row.fetchedAt };
  }

  async putMany(
    sourceId: string,
    entries: readonly { tile: TileCoord; bytes: Uint8Array | null }[],
    fetchedAt: number
  ): Promise<void> {
    const db = (await this.db()) ?? this.fallback;
    try {
      await db.upsertMany(sourceId, entries, fetchedAt);
      // Evict singly: a put only ever overshoots by one bundle's worth, and
      // row-at-a-time keeps the cap exact instead of dumping a whole batch.
      // Zero-size rows (persisted empties) don't shrink the total, so the
      // loop guard is "did anything delete", not "did the total drop".
      while ((await db.totalBytes()) > this.maxBytes) {
        if ((await db.evictOldest(1)) === 0) break;
      }
    } catch {
      await this.fallback.upsertMany(sourceId, entries, fetchedAt);
    }
  }
}

// ─── In-memory TileDb (fallback + web/Expo Go) ────────────────────────────────

function rowKey(source: string, tile: TileCoord): string {
  return `${source}|${tile.z}/${tile.x}/${tile.y}`;
}

export class InMemoryTileDb implements TileDb {
  private readonly rows = new Map<string, TileRow>();

  async get(source: string, tile: TileCoord): Promise<TileRow | null> {
    return this.rows.get(rowKey(source, tile)) ?? null;
  }

  async touch(source: string, tile: TileCoord, lastUsed: number): Promise<void> {
    const key = rowKey(source, tile);
    const row = this.rows.get(key);
    if (row) this.rows.set(key, { ...row, lastUsed });
  }

  async upsertMany(
    source: string,
    entries: readonly { tile: TileCoord; bytes: Uint8Array | null }[],
    fetchedAt: number
  ): Promise<void> {
    for (const { tile, bytes } of entries) {
      this.rows.set(rowKey(source, tile), { bytes, fetchedAt, lastUsed: fetchedAt });
    }
  }

  async totalBytes(): Promise<number> {
    let total = 0;
    for (const row of this.rows.values()) total += row.bytes?.byteLength ?? 0;
    return total;
  }

  async evictOldest(n: number): Promise<number> {
    const oldest = [...this.rows.entries()]
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
      .slice(0, n);
    for (const [key] of oldest) this.rows.delete(key);
    return oldest.length;
  }
}

// ─── expo-sqlite TileDb ───────────────────────────────────────────────────────

type SqlParam = string | number | null | Uint8Array;

export interface SqliteDb {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: SqlParam[]): Promise<{ changes: number }>;
  getFirstAsync<T>(sql: string, ...params: SqlParam[]): Promise<T | null>;
  withExclusiveTransactionAsync?(
    task: (transaction: Pick<SqliteDb, 'runAsync'>) => Promise<void>
  ): Promise<void>;
}

type SqliteModule = { openDatabaseAsync(name: string): Promise<SqliteDb> };

async function openSqliteTileDb(): Promise<TileDb | null> {
  let mod: SqliteModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy native load, same pattern as social/net/persistence.ts
    mod = require('expo-sqlite') as SqliteModule;
  } catch {
    return null;
  }
  try {
    const db = await mod.openDatabaseAsync(DB_NAME);
    await db.execAsync(
      `CREATE TABLE IF NOT EXISTS tiles (
         source TEXT NOT NULL,
         z INTEGER NOT NULL,
         x INTEGER NOT NULL,
         y INTEGER NOT NULL,
         bytes BLOB,
         size INTEGER NOT NULL,
         fetched_at INTEGER NOT NULL,
         last_used INTEGER NOT NULL,
         PRIMARY KEY (source, z, x, y)
       );
       CREATE INDEX IF NOT EXISTS tiles_lru ON tiles (last_used);`
    );
    return new SqliteTileDb(db);
  } catch {
    return null;
  }
}

interface SqliteTileRow {
  bytes: Uint8Array | null;
  fetched_at: number;
  last_used: number;
}

export class SqliteTileDb implements TileDb {
  constructor(private readonly db: SqliteDb) {}

  async get(source: string, tile: TileCoord): Promise<TileRow | null> {
    const row = await this.db.getFirstAsync<SqliteTileRow>(
      'SELECT bytes, fetched_at, last_used FROM tiles WHERE source = ? AND z = ? AND x = ? AND y = ?',
      source,
      tile.z,
      tile.x,
      tile.y
    );
    if (!row) return null;
    return {
      bytes: row.bytes ?? null,
      fetchedAt: Number(row.fetched_at),
      lastUsed: Number(row.last_used),
    };
  }

  async touch(source: string, tile: TileCoord, lastUsed: number): Promise<void> {
    await this.db.runAsync(
      'UPDATE tiles SET last_used = ? WHERE source = ? AND z = ? AND x = ? AND y = ?',
      lastUsed,
      source,
      tile.z,
      tile.x,
      tile.y
    );
  }

  async upsertMany(
    source: string,
    entries: readonly { tile: TileCoord; bytes: Uint8Array | null }[],
    fetchedAt: number
  ): Promise<void> {
    const writeEntries = async (db: Pick<SqliteDb, 'runAsync'>) => {
      for (const { tile, bytes } of entries) {
        await db.runAsync(
          `INSERT INTO tiles (source, z, x, y, bytes, size, fetched_at, last_used)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(source, z, x, y) DO UPDATE SET
             bytes = excluded.bytes, size = excluded.size,
             fetched_at = excluded.fetched_at, last_used = excluded.last_used`,
          source,
          tile.z,
          tile.x,
          tile.y,
          bytes,
          bytes?.byteLength ?? 0,
          fetchedAt,
          fetchedAt
        );
      }
    };
    if (this.db.withExclusiveTransactionAsync) {
      await this.db.withExclusiveTransactionAsync(writeEntries);
    } else {
      await writeEntries(this.db);
    }
  }

  async totalBytes(): Promise<number> {
    const row = await this.db.getFirstAsync<{ total: number }>(
      'SELECT COALESCE(SUM(size), 0) AS total FROM tiles'
    );
    return Number(row?.total ?? 0);
  }

  async evictOldest(n: number): Promise<number> {
    const res = await this.db.runAsync(
      `DELETE FROM tiles WHERE rowid IN (
         SELECT rowid FROM tiles ORDER BY last_used ASC LIMIT ?
       )`,
      n
    );
    return res.changes;
  }
}
