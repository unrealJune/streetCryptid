import type { PoolState } from '../core/pool';
import { InMemoryKV, type PersistentKV } from './background/fix-outbox';
import { InMemoryTrailStorage, type TrailPoint, type TrailStorage } from './background/trail-store';

/**
 * On-device persistence so the social feature survives JS reloads and app restarts. Backs the
 * `PersistentKV` (outbox + pool) and `TrailStorage` (trail cache) ports with expo-sqlite. The DB is
 * opened lazily and every access is guarded, so a build without the native module (or web/Expo Go)
 * transparently falls back to in-memory instead of crashing — matching the lazy-native pattern in
 * secure-keys.ts / background-task.ts. Two tables: `kv(key,value)` and
 * `trail(author,seq,fix,received_at,fix_ts)` keyed by `(author,seq)`.
 */

const DB_NAME = 'streetcryptid.social.db';

interface SqliteDb {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: (string | number | null)[]): Promise<{ changes: number }>;
  getFirstAsync<T>(sql: string, ...params: (string | number | null)[]): Promise<T | null>;
  getAllAsync<T>(sql: string, ...params: (string | number | null)[]): Promise<T[]>;
}

type SqliteModule = { openDatabaseAsync(name: string): Promise<SqliteDb> };

let sqlite: SqliteModule | null | undefined;

function trySqlite(): SqliteModule | null {
  if (sqlite !== undefined) return sqlite;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy native load; see above
    sqlite = require('expo-sqlite') as SqliteModule;
  } catch {
    sqlite = null;
  }
  return sqlite;
}

let dbPromise: Promise<SqliteDb | null> | undefined;

/** Open (once) and migrate the DB. Resolves null when SQLite is unavailable → in-memory fallback. */
function getDb(): Promise<SqliteDb | null> {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    const mod = trySqlite();
    if (!mod) return null;
    try {
      const db = await mod.openDatabaseAsync(DB_NAME);
      await db.execAsync(
        `CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS trail (
           author TEXT NOT NULL,
           seq INTEGER NOT NULL,
           fix TEXT NOT NULL,
           received_at INTEGER NOT NULL,
           fix_ts INTEGER NOT NULL,
           PRIMARY KEY (author, seq)
         );
         CREATE INDEX IF NOT EXISTS trail_author_ts ON trail (author, fix_ts);`
      );
      return db;
    } catch {
      return null;
    }
  })();
  return dbPromise;
}

/** expo-sqlite–backed {@link PersistentKV}, delegating to an in-memory store when SQLite is absent. */
class SqliteKV implements PersistentKV {
  private readonly fallback = new InMemoryKV();

  async get(key: string): Promise<string | null> {
    const db = await getDb();
    if (!db) return this.fallback.get(key);
    try {
      const row = await db.getFirstAsync<{ value: string }>(
        'SELECT value FROM kv WHERE key = ?',
        key
      );
      return row?.value ?? null;
    } catch {
      return this.fallback.get(key);
    }
  }

  async set(key: string, value: string): Promise<void> {
    const db = await getDb();
    if (!db) return this.fallback.set(key, value);
    try {
      await db.runAsync(
        'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        key,
        value
      );
    } catch {
      await this.fallback.set(key, value);
    }
  }

  async remove(key: string): Promise<void> {
    const db = await getDb();
    if (!db) return this.fallback.remove(key);
    try {
      await db.runAsync('DELETE FROM kv WHERE key = ?', key);
    } catch {
      await this.fallback.remove(key);
    }
  }
}

/** A durable {@link PersistentKV} (expo-sqlite); in-memory when SQLite is unavailable. */
export function createPersistentKV(): PersistentKV {
  return trySqlite() ? new SqliteKV() : new InMemoryKV();
}

interface TrailRow {
  author: string;
  seq: number;
  fix: string;
  received_at: number;
}

function rowToPoint(row: TrailRow): TrailPoint {
  return {
    author: row.author,
    seq: Number(row.seq),
    fix: JSON.parse(row.fix) as TrailPoint['fix'],
    receivedAt: Number(row.received_at),
  };
}

/** expo-sqlite–backed {@link TrailStorage} with SQL range/latest/prune; in-memory fallback. */
class SqliteTrailStorage implements TrailStorage {
  private readonly fallback = new InMemoryTrailStorage();

  async put(point: TrailPoint): Promise<void> {
    const db = await getDb();
    if (!db) return this.fallback.put(point);
    try {
      await db.runAsync(
        `INSERT INTO trail (author, seq, fix, received_at, fix_ts) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(author, seq) DO UPDATE SET
           fix = excluded.fix, received_at = excluded.received_at, fix_ts = excluded.fix_ts`,
        point.author,
        point.seq,
        JSON.stringify(point.fix),
        point.receivedAt,
        point.fix.ts
      );
    } catch {
      await this.fallback.put(point);
    }
  }

  async range(author: string, sinceTs: number): Promise<TrailPoint[]> {
    const db = await getDb();
    if (!db) return this.fallback.range(author, sinceTs);
    try {
      const rows = await db.getAllAsync<TrailRow>(
        'SELECT author, seq, fix, received_at FROM trail WHERE author = ? AND fix_ts >= ? ORDER BY seq ASC',
        author,
        sinceTs
      );
      return rows.map(rowToPoint);
    } catch {
      return this.fallback.range(author, sinceTs);
    }
  }

  async latest(): Promise<TrailPoint[]> {
    const db = await getDb();
    if (!db) return this.fallback.latest();
    try {
      const rows = await db.getAllAsync<TrailRow>(
        `SELECT t.author, t.seq, t.fix, t.received_at FROM trail t
         JOIN (SELECT author, MAX(fix_ts) AS mt FROM trail GROUP BY author) m
           ON t.author = m.author AND t.fix_ts = m.mt
         GROUP BY t.author`
      );
      return rows.map(rowToPoint);
    } catch {
      return this.fallback.latest();
    }
  }

  async prune(olderThanTs: number): Promise<number> {
    const db = await getDb();
    if (!db) return this.fallback.prune(olderThanTs);
    try {
      const res = await db.runAsync('DELETE FROM trail WHERE fix_ts < ?', olderThanTs);
      return res.changes;
    } catch {
      return this.fallback.prune(olderThanTs);
    }
  }
}

/** A durable {@link TrailStorage} (expo-sqlite); in-memory when SQLite is unavailable. */
export function createPersistentTrailStorage(): TrailStorage {
  return trySqlite() ? new SqliteTrailStorage() : new InMemoryTrailStorage();
}

const POOL_KEY = 'sc.social.pool';

/** Load the persisted sharing pool (friends + sharingWith), or null if none/unavailable. */
export async function loadPool(kv: PersistentKV): Promise<PoolState | null> {
  const raw = await kv.get(POOL_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PoolState>;
    return {
      friends: parsed.friends ?? {},
      sharingWith: Array.isArray(parsed.sharingWith) ? parsed.sharingWith : [],
    };
  } catch {
    return null;
  }
}

/** Persist the sharing pool so friends + sharing state survive a reload. */
export async function savePool(kv: PersistentKV, state: PoolState): Promise<void> {
  await kv.set(
    POOL_KEY,
    JSON.stringify({ friends: state.friends, sharingWith: state.sharingWith })
  );
}
