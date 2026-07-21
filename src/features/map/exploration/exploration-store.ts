import type { LocationFix } from '@/features/social/core/types';
import { SELF_AUTHOR, type TrailStorage } from '@/features/social/net/background/trail-store';

import { H3_DISPLAY_RES } from '../core/cell-ladder';
import type { CellIndex, H3Grid } from '../core/h3-grid';
import { latLonToWorld } from '../core/mercator';

/**
 * Durable record of which res-10 H3 cells the user has explored — the map's
 * own database, deliberately separate from the disposable tile cache
 * (exploration is user data and is never evicted) and from the social DB
 * (it never syncs; cells never leave the device).
 *
 * Two inputs feed it:
 *  - `recordFix` for live fixes while the map is open, and
 *  - `backfillFromTrail`, a cursor-driven scan of the persisted `self` trail
 *    that folds in fixes published while the app was backgrounded or dead.
 *
 * Follows the lazy-native expo-sqlite pattern of social/net/persistence.ts:
 * the DB opens on first use, every access is guarded, and builds without the
 * native module degrade to in-memory. Logic runs against the narrow
 * {@link ExplorationDb} port so tests use a fake instead of real SQL.
 */

const DB_NAME = 'streetcryptid.exploration.db';

/** Fixes coarser than this can't place the user in a ~131 m cell — ignored. */
export const EXPLORATION_ACCURACY_MAX_M = 100;

const BACKFILL_CURSOR_KEY = 'backfill.cursor';

/** Minimal storage port: SQLite in the app, a Map fake in tests. */
export interface ExplorationDb {
  allCells(): Promise<CellIndex[]>;
  insertCell(cell: CellIndex, ts: number): Promise<void>;
  /** Bump last_ts for an already-known cell (first_ts is preserved). */
  touchCell(cell: CellIndex, ts: number): Promise<void>;
  getKv(key: string): Promise<string | null>;
  setKv(key: string, value: string): Promise<void>;
}

export interface ExplorationStore {
  /** All explored cells; resolves after the DB is loaded. */
  load(): Promise<ReadonlySet<CellIndex>>;
  /**
   * Fold one fix in. Resolves the cell index when it is NEWLY explored,
   * null when it was already known or failed the accuracy gate.
   */
  recordFix(fix: LocationFix): Promise<CellIndex | null>;
  /**
   * Fold in every `self` trail point newer than the persisted cursor.
   * Idempotent; resolves the number of newly explored cells.
   */
  backfillFromTrail(storage: TrailStorage): Promise<CellIndex[]>;
}

export interface ExplorationStoreOptions {
  readonly grid: H3Grid;
  /** Injectable opener for tests; `null` resolution → in-memory fallback. */
  readonly openDb?: () => Promise<ExplorationDb | null>;
}

export function createExplorationStore(opts: ExplorationStoreOptions): ExplorationStore {
  return new DbExplorationStore(opts.grid, opts.openDb ?? openSqliteExplorationDb);
}

class DbExplorationStore implements ExplorationStore {
  private readonly fallback = new InMemoryExplorationDb();
  private dbPromise: Promise<ExplorationDb | null> | undefined;
  private knownPromise: Promise<Set<CellIndex>> | undefined;

  constructor(
    private readonly grid: H3Grid,
    private readonly openDb: () => Promise<ExplorationDb | null>
  ) {}

  private db(): Promise<ExplorationDb> {
    if (!this.dbPromise) this.dbPromise = this.openDb().catch(() => null);
    return this.dbPromise.then((db) => db ?? this.fallback);
  }

  private known(): Promise<Set<CellIndex>> {
    if (!this.knownPromise) {
      this.knownPromise = this.db()
        .then((db) => db.allCells())
        .then((cells) => new Set(cells));
    }
    return this.knownPromise;
  }

  async load(): Promise<ReadonlySet<CellIndex>> {
    return this.known();
  }

  async recordFix(fix: LocationFix): Promise<CellIndex | null> {
    if (fix.accuracyM > EXPLORATION_ACCURACY_MAX_M) return null;
    const cell = this.grid.cellAt(latLonToWorld({ lat: fix.lat, lon: fix.lon }), H3_DISPLAY_RES);
    const known = await this.known();
    const db = await this.db();
    if (known.has(cell)) {
      // Best-effort freshness; losing a touch never loses exploration.
      await db.touchCell(cell, fix.ts).catch(() => {});
      return null;
    }
    known.add(cell);
    await db.insertCell(cell, fix.ts).catch(() => {});
    return cell;
  }

  async backfillFromTrail(storage: TrailStorage): Promise<CellIndex[]> {
    const db = await this.db();
    const cursor = Number((await db.getKv(BACKFILL_CURSOR_KEY)) ?? 0);
    const points = await storage.range(SELF_AUTHOR, cursor);
    const added: CellIndex[] = [];
    let maxTs = cursor - 1;
    for (const point of points) {
      const cell = await this.recordFix(point.fix);
      if (cell) added.push(cell);
      if (point.fix.ts > maxTs) maxTs = point.fix.ts;
    }
    if (points.length) {
      // range() is inclusive, so resume strictly after the newest folded fix.
      await db.setKv(BACKFILL_CURSOR_KEY, String(maxTs + 1));
    }
    return added;
  }
}

// ─── In-memory ExplorationDb (fallback + tests) ───────────────────────────────

export class InMemoryExplorationDb implements ExplorationDb {
  readonly cells = new Map<CellIndex, { firstTs: number; lastTs: number }>();
  readonly kv = new Map<string, string>();

  async allCells(): Promise<CellIndex[]> {
    return [...this.cells.keys()];
  }
  async insertCell(cell: CellIndex, ts: number): Promise<void> {
    if (!this.cells.has(cell)) this.cells.set(cell, { firstTs: ts, lastTs: ts });
  }
  async touchCell(cell: CellIndex, ts: number): Promise<void> {
    const row = this.cells.get(cell);
    if (row) row.lastTs = ts;
  }
  async getKv(key: string): Promise<string | null> {
    return this.kv.get(key) ?? null;
  }
  async setKv(key: string, value: string): Promise<void> {
    this.kv.set(key, value);
  }
}

// ─── expo-sqlite ExplorationDb ────────────────────────────────────────────────

interface SqliteDb {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: (string | number)[]): Promise<{ changes: number }>;
  getFirstAsync<T>(sql: string, ...params: (string | number)[]): Promise<T | null>;
  getAllAsync<T>(sql: string, ...params: (string | number)[]): Promise<T[]>;
}

type SqliteModule = { openDatabaseAsync(name: string): Promise<SqliteDb> };

async function openSqliteExplorationDb(): Promise<ExplorationDb | null> {
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
      `CREATE TABLE IF NOT EXISTS explored (
         cell TEXT PRIMARY KEY NOT NULL,
         first_ts INTEGER NOT NULL,
         last_ts INTEGER NOT NULL
       );
       CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);`
    );
    return new SqliteExplorationDb(db);
  } catch {
    return null;
  }
}

class SqliteExplorationDb implements ExplorationDb {
  constructor(private readonly db: SqliteDb) {}

  async allCells(): Promise<CellIndex[]> {
    const rows = await this.db.getAllAsync<{ cell: string }>('SELECT cell FROM explored');
    return rows.map((r) => r.cell);
  }

  async insertCell(cell: CellIndex, ts: number): Promise<void> {
    await this.db.runAsync(
      'INSERT INTO explored (cell, first_ts, last_ts) VALUES (?, ?, ?) ON CONFLICT(cell) DO NOTHING',
      cell,
      ts,
      ts
    );
  }

  async touchCell(cell: CellIndex, ts: number): Promise<void> {
    await this.db.runAsync('UPDATE explored SET last_ts = ? WHERE cell = ?', ts, cell);
  }

  async getKv(key: string): Promise<string | null> {
    const row = await this.db.getFirstAsync<{ value: string }>(
      'SELECT value FROM kv WHERE key = ?',
      key
    );
    return row?.value ?? null;
  }

  async setKv(key: string, value: string): Promise<void> {
    await this.db.runAsync(
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value
    );
  }
}
