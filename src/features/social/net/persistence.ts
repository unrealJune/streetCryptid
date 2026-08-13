import type { PoolState } from '../core/pool';
import { InMemoryKV, type PersistentKV } from './background/fix-outbox';
import type { HandledNonce } from './live-requests';
import { DEFAULT_SHARE_INTERVAL_MS } from './background/sampling-policy';
import {
  InMemoryTrailStorage,
  SELF_AUTHOR,
  UNRESOLVED_VIA,
  type TrailPoint,
  type TrailStorage,
} from './background/trail-store';

/**
 * On-device persistence so the social feature survives JS reloads and app restarts. Backs the
 * `PersistentKV` (outbox + pool) and `TrailStorage` ports with expo-sqlite. The DB is
 * opened lazily and every access is guarded, so a build without the native module (or web/Expo Go)
 * transparently falls back to in-memory instead of crashing — matching the lazy-native pattern in
 * secure-keys.ts / background-task.ts.
 *
 * Three tables: `kv(key,value)`, `self_trail(seq,…)` — our own published points, retained as
 * history — and `friend_latest(author,…)` — exactly one current fix per friend. The split is the
 * schema-level form of FORWARD-SECRECY.md §4.4/§5.3: there is no table a friend's *older* fix
 * could be read back out of. The migration drops the old combined `trail` table, which held every
 * author's fixes as plaintext JSON forever and was the dominant term for the device-seizure
 * threat — but carries OUR OWN rows across first, because that half is the user's own data to
 * keep and dropping it would silently erase their history on upgrade.
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
         CREATE TABLE IF NOT EXISTS self_trail (
           seq INTEGER PRIMARY KEY NOT NULL,
           fix TEXT NOT NULL,
           received_at INTEGER NOT NULL,
           fix_ts INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS self_trail_ts ON self_trail (fix_ts);
         CREATE TABLE IF NOT EXISTS friend_latest (
           author TEXT PRIMARY KEY NOT NULL,
           seq INTEGER NOT NULL,
           fix TEXT NOT NULL,
           received_at INTEGER NOT NULL,
           fix_ts INTEGER NOT NULL,
           via TEXT
         );`
      );
      // One-shot migration off the old combined `trail` table. Our own rows move across — that
      // half is the user's own history and dropping it would erase their trail on upgrade — while
      // every friend row is left behind and destroyed with the table, which is the point: their
      // retained movements are erased rather than pruned (FORWARD-SECRECY.md §5.3).
      //
      // Guarded rather than branched on a schema version because there is none. On a fresh install
      // (and on every launch after the migration has run) the SELECT throws "no such table" and
      // the DROP is skipped, so this is idempotent.
      try {
        await db.runAsync(
          `INSERT OR IGNORE INTO self_trail (seq, fix, received_at, fix_ts)
             SELECT seq, fix, received_at, fix_ts FROM trail WHERE author = ?`,
          SELF_AUTHOR
        );
        await db.execAsync('DROP TABLE trail');
      } catch {
        // No legacy table to migrate.
      }
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
}

function rowToPoint(row: TrailRow): TrailPoint {
  return {
    author: row.author,
    seq: Number(row.seq),
    fix: JSON.parse(row.fix) as TrailPoint['fix'],
    receivedAt: Number(row.received_at),
    ...(row.via ? { via: row.via as NonNullable<TrailPoint['via']> } : {}),
  };
}

/** expo-sqlite–backed {@link TrailStorage}; in-memory fallback when SQLite is unavailable. */
class SqliteTrailStorage implements TrailStorage {
  private readonly fallback = new InMemoryTrailStorage();

  async putSelf(point: TrailPoint): Promise<void> {
    const db = await getDb();
    if (!db) return this.fallback.putSelf(point);
    try {
      await db.runAsync(
        `INSERT INTO self_trail (seq, fix, received_at, fix_ts) VALUES (?, ?, ?, ?)
         ON CONFLICT(seq) DO UPDATE SET
           fix = excluded.fix, received_at = excluded.received_at, fix_ts = excluded.fix_ts`,
        point.seq,
        JSON.stringify(point.fix),
        point.receivedAt,
        point.fix.ts
      );
    } catch {
      await this.fallback.putSelf(point);
    }
  }

  async selfRange(sinceTs: number): Promise<TrailPoint[]> {
    const db = await getDb();
    if (!db) return this.fallback.selfRange(sinceTs);
    try {
      const rows = await db.getAllAsync<Omit<TrailRow, 'author'>>(
        'SELECT seq, fix, received_at FROM self_trail WHERE fix_ts >= ? ORDER BY seq ASC',
        sinceTs
      );
      return rows.map((row) => rowToPoint({ ...row, author: SELF_AUTHOR }));
    } catch {
      return this.fallback.selfRange(sinceTs);
    }
  }

  async putFriendLatest(point: TrailPoint): Promise<void> {
    const db = await getDb();
    if (!db) return this.fallback.putFriendLatest(point);
    try {
      // The WHERE guard is the last-write-wins rule in SQL: a delivery carrying an OLDER payload
      // than the row we hold is dropped, so out-of-order arrival (gossip racing a docs
      // reconciliation) cannot rewind a friend's position on the map. It orders by `(fix_ts, seq)`
      // rather than fix_ts alone so a tie cannot turn on row order.
      //
      // The tie admits `seq >=`, not `>`, so that RE-delivery of the fix we already hold still
      // reaches the `via` merge below: `refreshTrailFromReplica` re-reads the whole replica after
      // each sync and routinely beats the callback carrying the precise label. Nothing else in the
      // row changes on that path — equal `(fix_ts, seq)` is the same fix.
      await db.runAsync(
        `INSERT INTO friend_latest (author, seq, fix, received_at, fix_ts, via) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(author) DO UPDATE SET
           seq = excluded.seq, fix = excluded.fix, received_at = excluded.received_at,
           fix_ts = excluded.fix_ts,
           via = CASE WHEN friend_latest.via IS NULL OR friend_latest.via = ?
                      THEN COALESCE(excluded.via, friend_latest.via) ELSE friend_latest.via END
         WHERE excluded.fix_ts > friend_latest.fix_ts
            OR (excluded.fix_ts = friend_latest.fix_ts AND excluded.seq >= friend_latest.seq)`,
        // Bound positionally, left-to-right across the whole statement: the six VALUES first,
        // then the CASE's comparison value.
        point.author,
        point.seq,
        JSON.stringify(point.fix),
        point.receivedAt,
        point.fix.ts,
        point.via ?? null,
        UNRESOLVED_VIA
      );
    } catch {
      await this.fallback.putFriendLatest(point);
    }
  }

  async friendLatest(): Promise<TrailPoint[]> {
    const db = await getDb();
    if (!db) return this.fallback.friendLatest();
    try {
      const rows = await db.getAllAsync<TrailRow>(
        'SELECT author, seq, fix, received_at, via FROM friend_latest'
      );
      return rows.map(rowToPoint);
    } catch {
      return this.fallback.friendLatest();
    }
  }

  async removeFriend(author: string): Promise<number> {
    const db = await getDb();
    if (!db) return this.fallback.removeFriend(author);
    try {
      const res = await db.runAsync('DELETE FROM friend_latest WHERE author = ?', author);
      return res.changes;
    } catch {
      return this.fallback.removeFriend(author);
    }
  }

  async pruneSelf(olderThanTs: number): Promise<number> {
    const db = await getDb();
    if (!db) return this.fallback.pruneSelf(olderThanTs);
    try {
      const res = await db.runAsync('DELETE FROM self_trail WHERE fix_ts < ?', olderThanTs);
      return res.changes;
    } catch {
      return this.fallback.pruneSelf(olderThanTs);
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
