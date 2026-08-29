import { AppState } from 'react-native';

export type EventLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type EventLogStatus = 'ok' | 'error' | 'unset';
export type EventLogLaunchContext = 'foreground' | 'background';

export interface EventLogEntry {
  id: string;
  timestamp: number;
  level: EventLogLevel;
  category: string;
  action: string;
  summary: string;
  status: EventLogStatus;
  launchContext: EventLogLaunchContext;
  transport?: string;
  details: unknown;
  /**
   * Build provenance as it was **when this row was written**, JSON-encoded, or undefined for rows
   * written before this column existed.
   *
   * Recorded rather than read at send time because the two differ exactly where it matters. The
   * shipper drains a durable journal, so a row survives the upgrade that changes the build — and
   * stamping the *current* build on it at send time produced spans dated two days before the
   * commit they claimed to come from. That is not a cosmetic error: `app.commit` and
   * `service.version` exist to answer "which build is this phone actually running?", and the
   * backlogged background rows this journal exists to preserve were the ones it answered wrongly.
   *
   * Late-resolved identity (`device.id`, `service.instance.id`) is deliberately NOT captured here.
   * It is constant for the install and simply unknown early, so send time is the right moment for
   * it — which is what made the original single-resource design look correct.
   */
  buildResource?: string;
}

export interface RecordEventLogEntry {
  timestamp?: number;
  level?: EventLogLevel;
  category: string;
  action: string;
  summary: string;
  status?: EventLogStatus;
  transport?: string;
  details?: unknown;
}

type EventLogListener = (entries: EventLogEntry[]) => void;

interface SqliteDb {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: (string | number | null)[]): Promise<unknown>;
  getFirstAsync<T>(sql: string, ...params: (string | number | null)[]): Promise<T | null>;
  getAllAsync<T>(sql: string, ...params: (string | number | null)[]): Promise<T[]>;
}

type SqliteModule = { openDatabaseAsync(name: string): Promise<SqliteDb> };

interface EventLogRow {
  id: string;
  timestamp: number;
  level: EventLogLevel;
  category: string;
  action: string;
  summary: string;
  status: EventLogStatus;
  transport: string | null;
  launch_context: EventLogLaunchContext | null;
  details: string;
  build_resource: string | null;
}

interface SqliteColumn {
  name: string;
}

const DB_NAME = 'streetcryptid.events.db';
export const EVENT_LOG_MAX_ENTRIES = 10_000;
const SENSITIVE_KEY = /authorization|password|psk|secret|ticket|token/i;
const LOCATION_KEY = /^(lat|latitude|lon|lng|longitude)$/i;

let sqlite: SqliteModule | null | undefined;
let dbPromise: Promise<SqliteDb | null> | undefined;
let entries: EventLogEntry[] = [];
let sequence = 0;
let persistenceQueue: Promise<void> = Promise.resolve();
let clearGeneration = 0;
let writesSinceTrim = 0;
let backgroundContextDepth = 0;
/**
 * Ids already handed to the shipper. Mirrors the `shipped` column, and is the ONLY record of it
 * when SQLite is unavailable (jest, web, Expo Go) — where the journal is the in-memory list alone.
 */
const shippedIds = new Set<string>();
const listeners = new Set<EventLogListener>();
/**
 * Build provenance stamped on rows written from now on, JSON-encoded once (this is on the path of
 * every recorded span, and it does not change within a process).
 */
let buildResourceJson: string | undefined;

/**
 * Declare the build that is writing rows, so each one carries its own provenance to the collector
 * rather than borrowing whatever build happens to drain it. See {@link EventLogEntry.buildResource}.
 *
 * Idempotent and safe to call before SQLite is up: it only affects rows recorded after it.
 */
export function setJournalBuildResource(attributes: Record<string, unknown>): void {
  const keys = Object.keys(attributes);
  buildResourceJson = keys.length > 0 ? JSON.stringify(attributes) : undefined;
}

/** Test seam. */
export function resetJournalBuildResourceForTesting(): void {
  buildResourceJson = undefined;
}

function trySqlite(): SqliteModule | null {
  if (sqlite !== undefined) return sqlite;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy native load
    sqlite = require('expo-sqlite') as SqliteModule;
  } catch {
    sqlite = null;
  }
  return sqlite;
}

function getDb(): Promise<SqliteDb | null> {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    const mod = trySqlite();
    if (!mod) return null;
    try {
      const db = await mod.openDatabaseAsync(DB_NAME);
      await db.execAsync(`CREATE TABLE IF NOT EXISTS event_log (
        id TEXT PRIMARY KEY NOT NULL,
        timestamp INTEGER NOT NULL,
        level TEXT NOT NULL,
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL,
        launch_context TEXT,
        transport TEXT,
        details TEXT NOT NULL,
        shipped INTEGER NOT NULL DEFAULT 0,
        build_resource TEXT
      );
      CREATE INDEX IF NOT EXISTS event_log_timestamp ON event_log (timestamp DESC);
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );`);
      const columns = await db.getAllAsync<SqliteColumn>('PRAGMA table_info(event_log)');
      if (!columns.some((column) => column.name === 'launch_context')) {
        await db.execAsync('ALTER TABLE event_log ADD COLUMN launch_context TEXT');
      }
      if (!columns.some((column) => column.name === 'shipped')) {
        await db.execAsync('ALTER TABLE event_log ADD COLUMN shipped INTEGER NOT NULL DEFAULT 0');
      }
      if (!columns.some((column) => column.name === 'build_resource')) {
        await db.execAsync('ALTER TABLE event_log ADD COLUMN build_resource TEXT');
      }
      // The shipper's hot query is "oldest unshipped first"; without this it is a full scan of a
      // 10 000-row table on every background wake.
      await db.execAsync(
        'CREATE INDEX IF NOT EXISTS event_log_shipped ON event_log (shipped, timestamp ASC)'
      );
      return db;
    } catch {
      return null;
    }
  })();
  return dbPromise;
}

function sanitizeText(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/gi, '******')
    .replace(
      /(authorization|password|psk|secret|ticket|token)(["'\s_:=]+)([^,\s}"']+)/gi,
      '$1$2[REDACTED]'
    )
    .replace(/\b(lat|latitude|lon|lng|longitude)(["'\s_:=]+)-?\d+(?:\.\d+)?/gi, '$1$2[REDACTED]');
}

function sanitize(value: unknown, key = '', seen = new WeakSet<object>()): unknown {
  // A key match plus a non-scalar value is a secret; a key match on a boolean or a number is
  // almost always a FLAG about a secret rather than the secret itself (`stash.ticket_configured`,
  // `sas_verified_sessions`). Redacting those cost real diagnostic value — they are exactly the
  // attributes that say whether a device was configured to reach the stash at all — and gave up
  // nothing, since a boolean carries no key material. Location stays redacted at every type: a
  // latitude is a number, and that is the point.
  if (SENSITIVE_KEY.test(key) && typeof value !== 'boolean' && typeof value !== 'number') {
    return '[REDACTED]';
  }
  if (LOCATION_KEY.test(key)) return '[LOCATION REDACTED]';
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'undefined'
  ) {
    return value;
  }
  if (typeof value === 'string') {
    const redacted = sanitizeText(value);
    return redacted.length > 1000 ? `${redacted.slice(0, 1000)}…` : redacted;
  }
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, key, seen));
  return Object.fromEntries(
    Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      sanitize(childValue, childKey, seen),
    ])
  );
}

function rowToEntry(row: EventLogRow): EventLogEntry {
  const { launch_context, transport, details, build_resource, ...rest } = row;
  return {
    ...rest,
    timestamp: Number(row.timestamp),
    launchContext: launch_context === 'background' ? 'background' : 'foreground',
    ...(transport ? { transport } : {}),
    details: sanitize(JSON.parse(details) as unknown),
    ...(build_resource ? { buildResource: build_resource } : {}),
  };
}

function notify(): void {
  if (listeners.size === 0) return;
  const snapshot = [...entries];
  listeners.forEach((listener) => listener(snapshot));
}

function enqueuePersistence(operation: () => Promise<void>): Promise<void> {
  persistenceQueue = persistenceQueue.then(operation, operation);
  return persistenceQueue;
}

async function persist(entry: EventLogEntry): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await db.runAsync(
      `INSERT OR REPLACE INTO event_log
       (id, timestamp, level, category, action, summary, status, launch_context, transport, details,
        build_resource)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.id,
      entry.timestamp,
      entry.level,
      entry.category,
      entry.action,
      entry.summary,
      entry.status,
      entry.launchContext,
      entry.transport ?? null,
      JSON.stringify(entry.details),
      entry.buildResource ?? null
    );
    writesSinceTrim += 1;
    if (writesSinceTrim >= 100) {
      writesSinceTrim = 0;
      await db.runAsync(
        `DELETE FROM event_log WHERE id NOT IN (
          SELECT id FROM event_log ORDER BY timestamp DESC, rowid DESC LIMIT ?
        )`,
        EVENT_LOG_MAX_ENTRIES
      );
    }
  } catch {
    // The in-memory journal remains usable if persistence is unavailable.
  }
}

function currentLaunchContext(): EventLogLaunchContext {
  return backgroundContextDepth > 0 || AppState.currentState === 'background'
    ? 'background'
    : 'foreground';
}

export async function withEventLogLaunchContext<T>(
  context: EventLogLaunchContext,
  operation: () => Promise<T>
): Promise<T> {
  if (context === 'background') backgroundContextDepth += 1;
  try {
    return await operation();
  } finally {
    if (context === 'background') backgroundContextDepth -= 1;
  }
}

function searchableValues(value: unknown, path = ''): string[] {
  if (typeof value === 'undefined') return [];
  if (value === null || typeof value !== 'object') {
    const text = String(value);
    if (!path) return [text];
    const key = path.split('.').at(-1);
    return [text, `${path}:${text}`, ...(key ? [`${key}:${text}`] : [])];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => searchableValues(item, path));
  }
  return Object.entries(value).flatMap(([key, child]) =>
    searchableValues(child, path ? `${path}.${key}` : key)
  );
}

export function eventLogEntryMatchesQuery(entry: EventLogEntry, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  const fields = {
    name: entry.action,
    action: entry.action,
    summary: entry.summary,
    category: entry.category,
    level: entry.level,
    status: entry.status,
    launchContext: entry.launchContext,
    transport: entry.transport,
    details: entry.details,
  };
  return searchableValues(fields).some((value) => value.toLocaleLowerCase().includes(normalized));
}

export function recordEventLog(input: RecordEventLogEntry): EventLogEntry {
  const timestamp = input.timestamp ?? Date.now();
  const entry: EventLogEntry = {
    id: `${timestamp}-${sequence++}-${Math.random().toString(36).slice(2, 10)}`,
    timestamp,
    level: input.level ?? (input.status === 'error' ? 'error' : 'info'),
    category: input.category,
    action: input.action,
    summary: sanitizeText(input.summary),
    status: input.status ?? 'unset',
    launchContext: currentLaunchContext(),
    ...(input.transport ? { transport: input.transport } : {}),
    details: sanitize(input.details ?? {}),
    ...(buildResourceJson ? { buildResource: buildResourceJson } : {}),
  };
  entries.unshift(entry);
  if (entries.length > EVENT_LOG_MAX_ENTRIES) entries.pop();
  notify();
  void enqueuePersistence(() => persist(entry));
  return entry;
}

export function getEventLog(): EventLogEntry[] {
  return [...entries];
}

export async function loadEventLog(): Promise<EventLogEntry[]> {
  const generation = clearGeneration;
  const db = await getDb();
  if (!db) return getEventLog();
  try {
    const rows = await db.getAllAsync<EventLogRow>(
      `SELECT id, timestamp, level, category, action, summary, status, launch_context, transport,
              details, build_resource
       FROM event_log ORDER BY timestamp DESC, rowid DESC LIMIT ?`,
      EVENT_LOG_MAX_ENTRIES
    );
    const persisted: EventLogEntry[] = rows.map(rowToEntry);
    if (generation !== clearGeneration) return getEventLog();
    const merged = new Map(entries.map((entry) => [entry.id, entry]));
    persisted.forEach((entry) => {
      if (!merged.has(entry.id)) merged.set(entry.id, entry);
    });
    entries = [...merged.values()]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, EVENT_LOG_MAX_ENTRIES);
    notify();
  } catch {
    // Keep current in-memory entries.
  }
  return getEventLog();
}

export function subscribeEventLog(listener: EventLogListener): () => void {
  listeners.add(listener);
  listener(getEventLog());
  return () => listeners.delete(listener);
}

export function flushEventLog(): Promise<void> {
  return persistenceQueue;
}

export async function clearEventLog(): Promise<void> {
  clearGeneration += 1;
  shippedIds.clear();
  entries = [];
  notify();
  await enqueuePersistence(async () => {
    const db = await getDb();
    if (!db) return;
    try {
      await db.runAsync('DELETE FROM event_log');
    } catch {
      // The visible in-memory journal is still cleared.
    }
  });
}

/**
 * Read a small durable value from the journal database.
 *
 * The journal owns the only storage this module is allowed to touch: telemetry must not depend on
 * `net/persistence.ts` (that would make the dependency graph circular, since persistence reports
 * its own degradation through telemetry) and must stay self-contained so the build-time strip can
 * remove the whole directory in one piece. Returns null when SQLite is unavailable — every caller
 * has to cope with that anyway.
 */
export async function readMeta(key: string): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  try {
    const row = await db.getFirstAsync<{ value: string }>(
      'SELECT value FROM meta WHERE key = ?',
      key
    );
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/** Write a small durable value to the journal database. Best-effort; never throws. */
export async function writeMeta(key: string, value: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await db.runAsync(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value
    );
  } catch {
    // A device id we cannot persist is regenerated next launch — degraded, not broken.
  }
}

/**
 * Hand the shipper the oldest entries it has not taken yet, oldest first.
 *
 * Reads through SQLite when it is available, because that is the only place a backlog survives:
 * a headless background context starts with an empty in-memory list while the database still
 * holds everything the last few wakes recorded. The in-memory list is the fallback, not the
 * preference.
 *
 * Entries are NOT marked here. The shipper marks them only once the collector has accepted them
 * ({@link markShipped}), which is the whole point — a failed POST leaves them queued for the next
 * attempt instead of dropping them on the floor.
 */
export async function takeUnshipped(limit: number): Promise<EventLogEntry[]> {
  const db = await getDb();
  if (db) {
    try {
      const rows = await db.getAllAsync<EventLogRow>(
        `SELECT id, timestamp, level, category, action, summary, status, launch_context, transport,
                details, build_resource
         FROM event_log WHERE shipped = 0 ORDER BY timestamp ASC, rowid ASC LIMIT ?`,
        limit
      );
      // A row can be marked in memory but not yet in the database if a previous mark failed
      // mid-flight; filtering here keeps that from re-sending.
      return rows.map(rowToEntry).filter((entry) => !shippedIds.has(entry.id));
    } catch {
      // Fall through to the in-memory journal.
    }
  }
  const pending: EventLogEntry[] = [];
  // `entries` is newest-first; walk it backwards so the oldest go out first and a partial drain
  // leaves a contiguous, ordered backlog.
  for (let i = entries.length - 1; i >= 0 && pending.length < limit; i -= 1) {
    const entry = entries[i];
    if (!shippedIds.has(entry.id)) pending.push(entry);
  }
  return pending;
}

/** Mark entries as delivered. Best-effort in the database; authoritative in memory. */
export async function markShipped(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  ids.forEach((id) => shippedIds.add(id));
  await enqueuePersistence(async () => {
    const db = await getDb();
    if (!db) return;
    try {
      const placeholders = ids.map(() => '?').join(',');
      await db.runAsync(`UPDATE event_log SET shipped = 1 WHERE id IN (${placeholders})`, ...ids);
    } catch {
      // The in-memory set still prevents a re-send this process; a restart may re-send these
      // rows once, which the collector tolerates (same trace and span ids, so it is a rewrite,
      // not a duplicate).
    }
  });
}

/** How many entries are still waiting to be shipped, for the `device.health` record. */
export async function unshippedCount(): Promise<number> {
  const db = await getDb();
  if (db) {
    try {
      const row = await db.getFirstAsync<{ n: number }>(
        'SELECT COUNT(*) AS n FROM event_log WHERE shipped = 0'
      );
      if (row) return Number(row.n);
    } catch {
      // Fall through.
    }
  }
  return entries.reduce((n, entry) => (shippedIds.has(entry.id) ? n : n + 1), 0);
}

export function resetEventLogForTesting(): void {
  clearGeneration += 1;
  shippedIds.clear();
  entries = [];
  sequence = 0;
  writesSinceTrim = 0;
  backgroundContextDepth = 0;
  persistenceQueue = Promise.resolve();
  listeners.clear();
}
