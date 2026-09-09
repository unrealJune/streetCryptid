import type { SqliteDb } from './sqlite-tile-store';

export interface ResumeState {
  readonly etag: string;
  readonly size: number;
}

export interface BundleResumeStore {
  state(key: string): Promise<ResumeState | null>;
  chunks(key: string): AsyncIterable<Uint8Array>;
  append(key: string, etag: string, offset: number, bytes: Uint8Array): Promise<void>;
  remove(key: string): Promise<void>;
}

const MAX_BYTES = 256 * 1024 * 1024;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Incomplete transport bytes only; never consulted as a completed tile cache. */
export class MemoryBundleResumeStore implements BundleResumeStore {
  private rows = new Map<
    string,
    { etag: string; chunks: Uint8Array[]; size: number; at: number }
  >();

  async state(key: string): Promise<ResumeState | null> {
    this.prune();
    return this.rows.get(key) ?? null;
  }

  async *chunks(key: string): AsyncIterable<Uint8Array> {
    yield* this.rows.get(key)?.chunks ?? [];
  }

  async append(key: string, etag: string, offset: number, bytes: Uint8Array): Promise<void> {
    const row = this.rows.get(key) ?? { etag, chunks: [], size: 0, at: Date.now() };
    if (row.etag !== etag || row.size !== offset) throw new Error('Invalid bundle resume offset');
    row.chunks.push(bytes.slice());
    row.size += bytes.length;
    row.at = Date.now();
    this.rows.set(key, row);
    this.prune();
  }

  async remove(key: string): Promise<void> {
    this.rows.delete(key);
  }

  private prune() {
    let total = 0;
    for (const [key, row] of [...this.rows].sort((a, b) => b[1].at - a[1].at)) {
      total += row.size;
      if (total > MAX_BYTES || row.at < Date.now() - MAX_AGE_MS) this.rows.delete(key);
    }
  }
}

export class SqliteBundleResumeStore implements BundleResumeStore {
  constructor(private readonly db: SqliteDb) {}

  async state(key: string): Promise<ResumeState | null> {
    await this.db.runAsync(
      `DELETE FROM bundle_downloads WHERE key IN (
        SELECT key FROM bundle_downloads GROUP BY key HAVING MAX(at) < ?
      )`,
      Date.now() - MAX_AGE_MS
    );
    const row = await this.db.getFirstAsync<{ etag: string; size: number }>(
      'SELECT etag, SUM(length(bytes)) AS size FROM bundle_downloads WHERE key = ? GROUP BY etag',
      key
    );
    return row;
  }

  async *chunks(key: string): AsyncIterable<Uint8Array> {
    let offset = 0;
    while (true) {
      const row = await this.db.getFirstAsync<{ bytes: Uint8Array }>(
        'SELECT bytes FROM bundle_downloads WHERE key = ? AND offset = ?',
        key,
        offset
      );
      if (!row) return;
      yield row.bytes;
      offset += row.bytes.length;
    }
  }

  async append(key: string, etag: string, offset: number, bytes: Uint8Array): Promise<void> {
    const inserted = await this.db.runAsync(
      `INSERT INTO bundle_downloads (key, etag, offset, bytes, at)
       SELECT ?, ?, ?, ?, ?
       WHERE ? = (SELECT COALESCE(SUM(length(bytes)), 0) FROM bundle_downloads WHERE key = ?)
       AND NOT EXISTS (SELECT 1 FROM bundle_downloads WHERE key = ? AND etag != ?)`,
      key,
      etag,
      offset,
      bytes,
      Date.now(),
      offset,
      key,
      key,
      etag
    );
    if (inserted.changes !== 1) throw new Error('Invalid bundle resume offset or ETag');
    // Evict complete download journals, never individual middle chunks.
    while (true) {
      const row = await this.db.getFirstAsync<{ total: number }>(
        'SELECT COALESCE(SUM(length(bytes)), 0) AS total FROM bundle_downloads'
      );
      if (!row || row.total <= MAX_BYTES) break;
      const removed = await this.db.runAsync(
        `DELETE FROM bundle_downloads WHERE key IN (
          SELECT key FROM bundle_downloads GROUP BY key ORDER BY MAX(at) LIMIT 1
        )`
      );
      if (!removed.changes) throw new Error('Unable to bound tile download journal');
    }
  }

  async remove(key: string): Promise<void> {
    await this.db.runAsync('DELETE FROM bundle_downloads WHERE key = ?', key);
  }
}

let shared: Promise<BundleResumeStore> | undefined;
type SqliteModule = { openDatabaseAsync(name: string): Promise<SqliteDb> };

export function sharedBundleResumeStore(): Promise<BundleResumeStore> {
  return (shared ??= openStore());
}

async function openStore(): Promise<BundleResumeStore> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy native load like sqlite-tile-store
    const mod: SqliteModule = require('expo-sqlite');
    const db = await mod.openDatabaseAsync('streetcryptid.tile-downloads.db');
    await db.execAsync(`CREATE TABLE IF NOT EXISTS bundle_downloads (
      key TEXT NOT NULL, etag TEXT NOT NULL, offset INTEGER NOT NULL,
      bytes BLOB NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (key, offset)
    );`);
    return new SqliteBundleResumeStore(db);
  } catch (error) {
    console.warn('[map] durable download resume unavailable; using bounded memory:', error);
    return new MemoryBundleResumeStore();
  }
}
