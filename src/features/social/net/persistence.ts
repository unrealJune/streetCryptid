import type { PoolState } from '../core/pool';
import { InMemoryKV, type PersistentKV } from './background/fix-outbox';
import type { HandledNonce } from './live-requests';
import { DEFAULT_SHARE_INTERVAL_MS } from './background/sampling-policy';
import {
  InMemoryTrailStorage,
  UNRESOLVED_VIA,
  type TrailPoint,
  type TrailStorage,
} from './background/trail-store';

/**
 * On-device persistence so the social feature survives JS reloads and app restarts. Backs the
 * `PersistentKV` (outbox + pool) and `TrailStorage` (trail cache) ports with expo-sqlite. The DB is
 * opened lazily and every access is guarded, so a build without the native module (or web/Expo Go)
 * transparently falls back to in-memory instead of crashing — matching the lazy-native pattern in
 * secure-keys.ts / background-task.ts. Two tables: `kv(key,value)` and
 * `trail(author,seq,fix,received_at,fix_ts,via)` keyed by `(author,seq)`.
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
      // Added after the table shipped, and there is no schema version to branch on, so add the
      // column unconditionally and swallow the "duplicate column name" error on installs that
      // already have it. Rows written before this read back as NULL → provenance unknown.
      await db.execAsync('ALTER TABLE trail ADD COLUMN via TEXT').catch(() => {});
      // Same unconditional-add pattern as `via`. A JSON blob rather than columns: it is display-only
      // detail with a nested path list, never queried or joined on.
      await db.execAsync('ALTER TABLE trail ADD COLUMN delivery TEXT').catch(() => {});
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
  via: string | null;
  delivery: string | null;
}

/** Rows predate the column, or were written by a build that stored malformed JSON — neither is
 *  worth failing a trail read over, so an unparseable blob reads back as "no detail". */
function parseDelivery(raw: string | null): TrailPoint['delivery'] {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as TrailPoint['delivery'];
  } catch {
    return undefined;
  }
}

function rowToPoint(row: TrailRow): TrailPoint {
  return {
    author: row.author,
    seq: Number(row.seq),
    fix: JSON.parse(row.fix) as TrailPoint['fix'],
    receivedAt: Number(row.received_at),
    ...(row.via ? { via: row.via as NonNullable<TrailPoint['via']> } : {}),
    ...((): { delivery?: TrailPoint['delivery'] } => {
      const delivery = parseDelivery(row.delivery);
      return delivery ? { delivery } : {};
    })(),
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
        `INSERT INTO trail (author, seq, fix, received_at, fix_ts, via, delivery)
           VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(author, seq) DO UPDATE SET
           fix = excluded.fix, received_at = excluded.received_at, fix_ts = excluded.fix_ts,
           -- delivery FIRST: it tests the pre-update trail.via, and SQLite applies SET clauses
           -- left to right, so reversing these would compare against the value just written.
           delivery = CASE WHEN trail.via IS NULL OR trail.via = ?
                           THEN COALESCE(excluded.delivery, trail.delivery)
                           WHEN trail.delivery IS NULL AND trail.via IS excluded.via
                           THEN excluded.delivery
                           ELSE trail.delivery END,
           via = CASE WHEN trail.via IS NULL OR trail.via = ?
                      THEN COALESCE(excluded.via, trail.via) ELSE trail.via END`,
        // Bound positionally, left-to-right across the whole statement: the seven VALUES first,
        // then one comparison value per CASE.
        point.author,
        point.seq,
        JSON.stringify(point.fix),
        point.receivedAt,
        point.fix.ts,
        point.via ?? null,
        point.delivery ? JSON.stringify(point.delivery) : null,
        UNRESOLVED_VIA,
        UNRESOLVED_VIA
      );
    } catch {
      await this.fallback.put(point);
    }
  }

  async putLatest(point: TrailPoint): Promise<void> {
    const db = await getDb();
    if (!db) return this.fallback.putLatest(point);
    try {
      await this.put(point);
      // Keep exactly one row for this author — the newest by (fix_ts, seq). Deciding it in SQL
      // rather than from `point` is deliberate: reconciliation delivers old entries after new
      // ones, so the point we just wrote is often NOT the newest.
      await db.runAsync(
        `DELETE FROM trail WHERE author = ? AND rowid NOT IN (
           SELECT rowid FROM trail WHERE author = ? ORDER BY fix_ts DESC, seq DESC LIMIT 1
         )`,
        point.author,
        point.author
      );
    } catch {
      await this.fallback.putLatest(point);
    }
  }

  async collapseToLatest(exceptAuthor: string): Promise<number> {
    const db = await getDb();
    if (!db) return this.fallback.collapseToLatest(exceptAuthor);
    try {
      const res = await db.runAsync(
        `DELETE FROM trail WHERE author <> ? AND rowid NOT IN (
           SELECT rowid FROM (
             SELECT rowid, ROW_NUMBER() OVER (
               PARTITION BY author ORDER BY fix_ts DESC, seq DESC
             ) AS rank FROM trail WHERE author <> ?
           ) WHERE rank = 1
         )`,
        exceptAuthor,
        exceptAuthor
      );
      return res.changes;
    } catch {
      return this.fallback.collapseToLatest(exceptAuthor);
    }
  }

  async range(author: string, sinceTs: number): Promise<TrailPoint[]> {
    const db = await getDb();
    if (!db) return this.fallback.range(author, sinceTs);
    try {
      const rows = await db.getAllAsync<TrailRow>(
        `SELECT author, seq, fix, received_at, via, delivery FROM trail
         WHERE author = ? AND fix_ts >= ? ORDER BY seq ASC`,
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
        `SELECT t.author, t.seq, t.fix, t.received_at, t.via, t.delivery FROM trail t
         JOIN (SELECT author, MAX(fix_ts) AS mt FROM trail GROUP BY author) m
           ON t.author = m.author AND t.fix_ts = m.mt
         GROUP BY t.author`
      );
      return rows.map(rowToPoint);
    } catch {
      return this.fallback.latest();
    }
  }

  async removeAuthor(author: string): Promise<number> {
    const db = await getDb();
    if (!db) return this.fallback.removeAuthor(author);
    try {
      const res = await db.runAsync('DELETE FROM trail WHERE author = ?', author);
      return res.changes;
    } catch {
      return this.fallback.removeAuthor(author);
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

const HANDLED_CTL_KEY = 'sc.social.handledControlNonces';

/**
 * Load the control-message nonces we have already acted on. Persisted, not in-memory: a request
 * the user declined must stay declined across a restart, or the next poll would re-prompt for it
 * (the sender's control slot still holds the same entry). See `live-requests.ts`.
 */
export async function loadHandledNonces(kv: PersistentKV): Promise<HandledNonce[]> {
  const raw = await kv.get(HANDLED_CTL_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (h): h is HandledNonce =>
        typeof (h as HandledNonce)?.nonce === 'string' &&
        typeof (h as HandledNonce)?.at === 'number'
    );
  } catch {
    return [];
  }
}

/** Persist the handled-nonce list. Callers prune first (`pruneHandledNonces`) so it stays small. */
export async function saveHandledNonces(
  kv: PersistentKV,
  handled: readonly HandledNonce[]
): Promise<void> {
  await kv.set(HANDLED_CTL_KEY, JSON.stringify(handled));
}

const STASH_OPTIN_KEY = 'sc.social.stashOptIn';

/** Whether the user has opted in to the trail stash (offline delivery). Defaults to false (opt-in). */
export async function loadStashOptIn(kv: PersistentKV): Promise<boolean> {
  return (await kv.get(STASH_OPTIN_KEY)) === '1';
}

/** Persist the trail-stash opt-in choice. */
export async function saveStashOptIn(kv: PersistentKV, optedIn: boolean): Promise<void> {
  await kv.set(STASH_OPTIN_KEY, optedIn ? '1' : '0');
}

const LOCATION_DISCLOSURE_KEY = 'sc.social.locationDisclosureAck';

export type LocationDisclosureChoice = 'accepted' | 'declined' | null;

/**
 * Whether the user has been shown the in-app background-location disclosure and what they chose.
 * `null` means the disclosure hasn't been shown yet this install (fresh install, or the KV/SQLite
 * store was unavailable and fell back to in-memory). Shown once, before the OS runtime permission
 * prompt fires — see `LocationDisclosureScreen`.
 */
export async function loadLocationDisclosureChoice(
  kv: PersistentKV
): Promise<LocationDisclosureChoice> {
  const raw = await kv.get(LOCATION_DISCLOSURE_KEY);
  return raw === 'accepted' || raw === 'declined' ? raw : null;
}

/** Persist the user's choice on the background-location disclosure screen. */
export async function saveLocationDisclosureChoice(
  kv: PersistentKV,
  choice: 'accepted' | 'declined'
): Promise<void> {
  await kv.set(LOCATION_DISCLOSURE_KEY, choice);
}

const SHARE_INTERVAL_KEY = 'sc.social.shareIntervalMs';

/**
 * The cadences offered in settings, in ms. A closed set rather than a free-form number, for two
 * reasons: all three divide the hour, so the engine's wall-clock slot grid stays aligned and
 * switching lands cleanly on a boundary; and the choice is visible to the trail-stash as a static
 * per-user cadence, where three options is a couple of bits and an arbitrary integer would be close
 * to a unique identifier. Order is fastest → slowest for display.
 */
export const SHARE_INTERVAL_OPTIONS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;

/**
 * How often location is published, in ms. Constant per user by design — it never varies with what
 * the user is doing (see `background/sampling-policy.ts`). Defaults to 5 min; an unparseable or
 * unrecognised stored value falls back rather than producing an interval off the slot grid.
 */
export async function loadShareIntervalMs(kv: PersistentKV): Promise<number> {
  const raw = await kv.get(SHARE_INTERVAL_KEY);
  const parsed = raw === null ? Number.NaN : Number(raw);
  return SHARE_INTERVAL_OPTIONS_MS.some((option) => option === parsed)
    ? parsed
    : DEFAULT_SHARE_INTERVAL_MS;
}

/** Persist the chosen publish cadence. Ignores values outside {@link SHARE_INTERVAL_OPTIONS_MS}. */
export async function saveShareIntervalMs(kv: PersistentKV, intervalMs: number): Promise<void> {
  if (!SHARE_INTERVAL_OPTIONS_MS.some((option) => option === intervalMs)) return;
  await kv.set(SHARE_INTERVAL_KEY, String(intervalMs));
}

const SHARING_ENABLED_KEY = 'sc.social.sharingEnabled';

/**
 * Whether the user has background sharing switched ON — the *intent*, not the current OS state.
 *
 * The distinction is the point. If the app is terminated (jetsam, a crash, a reboot) the OS location
 * task dies with it and nothing in-process survives to notice; a headless wake can then compare this
 * flag against `isBackgroundLocationRunning()` and re-arm. Without a persisted intent there is no
 * way to tell "sharing is off because the user turned it off" from "sharing is off because we were
 * killed", and the self-heal would either never fire or would resurrect sharing the user disabled.
 *
 * Defaults to false: an install that has never enabled sharing must never have it started for it.
 */
export async function loadSharingEnabled(kv: PersistentKV): Promise<boolean> {
  return (await kv.get(SHARING_ENABLED_KEY)) === '1';
}

/** Persist the background-sharing intent. Written by `startBackground` / `stopBackground`. */
export async function saveSharingEnabled(kv: PersistentKV, enabled: boolean): Promise<void> {
  await kv.set(SHARING_ENABLED_KEY, enabled ? '1' : '0');
}

const RELAY_ONLY_KEY = 'sc.social.relayOnly';
const TRANSPORT_CONFIG_KEY = 'sc.social.transportConfig';

export interface TransportPreferences {
  relay: boolean;
  ip: boolean;
  ble: boolean;
}

export const DEFAULT_TRANSPORT_PREFERENCES: TransportPreferences = {
  relay: true,
  ip: true,
  ble: true,
};

/**
 * Whether the user forced relay-only transport (no BLE / Wi-Fi Aware / direct / LAN). Defaults to
 * false: the full transport stack is used unless the user explicitly opts into relay-only.
 */
export async function loadRelayOnly(kv: PersistentKV): Promise<boolean> {
  return (await kv.get(RELAY_ONLY_KEY)) === '1';
}

/** Persist the force-relay-only choice. */
export async function saveRelayOnly(kv: PersistentKV, relayOnly: boolean): Promise<void> {
  await kv.set(RELAY_ONLY_KEY, relayOnly ? '1' : '0');
}

/** Restore debug transport restrictions, migrating the old relay-only preference when present. */
export async function loadTransportPreferences(kv: PersistentKV): Promise<TransportPreferences> {
  const raw = await kv.get(TRANSPORT_CONFIG_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<TransportPreferences>;
      if (
        typeof parsed.relay === 'boolean' &&
        typeof parsed.ip === 'boolean' &&
        typeof parsed.ble === 'boolean'
      ) {
        return parsed as TransportPreferences;
      }
    } catch {
      // Fall through to safe defaults.
    }
  }
  if (await loadRelayOnly(kv)) return { relay: true, ip: false, ble: false };
  return { ...DEFAULT_TRANSPORT_PREFERENCES };
}

/** Persist the endpoint transport set used for the next native bind. */
export async function saveTransportPreferences(
  kv: PersistentKV,
  preferences: TransportPreferences
): Promise<void> {
  await kv.set(TRANSPORT_CONFIG_KEY, JSON.stringify(preferences));
}
