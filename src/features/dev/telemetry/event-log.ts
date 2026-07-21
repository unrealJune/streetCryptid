export type EventLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type EventLogStatus = 'ok' | 'error' | 'unset';

export interface EventLogEntry {
  id: string;
  timestamp: number;
  level: EventLogLevel;
  category: string;
  action: string;
  summary: string;
  status: EventLogStatus;
  transport?: string;
  details: unknown;
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
  details: string;
}

const DB_NAME = 'streetcryptid.events.db';
const MAX_ENTRIES = 1000;
const SENSITIVE_KEY = /authorization|password|psk|secret|ticket|token/i;
const LOCATION_KEY = /^(lat|latitude|lon|lng|longitude)$/i;

let sqlite: SqliteModule | null | undefined;
let dbPromise: Promise<SqliteDb | null> | undefined;
let entries: EventLogEntry[] = [];
let sequence = 0;
let persistenceQueue: Promise<void> = Promise.resolve();
let clearGeneration = 0;
let writesSinceTrim = 0;
const listeners = new Set<EventLogListener>();

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
        transport TEXT,
        details TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS event_log_timestamp ON event_log (timestamp DESC);`);
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
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
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

function notify(): void {
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
       (id, timestamp, level, category, action, summary, status, transport, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.id,
      entry.timestamp,
      entry.level,
      entry.category,
      entry.action,
      entry.summary,
      entry.status,
      entry.transport ?? null,
      JSON.stringify(entry.details)
    );
    writesSinceTrim += 1;
    if (writesSinceTrim >= 100) {
      writesSinceTrim = 0;
      await db.runAsync(
        `DELETE FROM event_log WHERE id NOT IN (
          SELECT id FROM event_log ORDER BY timestamp DESC, rowid DESC LIMIT ?
        )`,
        MAX_ENTRIES
      );
    }
  } catch {
    // The in-memory journal remains usable if persistence is unavailable.
  }
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
    ...(input.transport ? { transport: input.transport } : {}),
    details: sanitize(input.details ?? {}),
  };
  entries = [entry, ...entries].slice(0, MAX_ENTRIES);
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
      `SELECT id, timestamp, level, category, action, summary, status, transport, details
       FROM event_log ORDER BY timestamp DESC, rowid DESC LIMIT ?`,
      MAX_ENTRIES
    );
    const persisted: EventLogEntry[] = rows.map((row) => {
      const { transport, details, ...rest } = row;
      return {
        ...rest,
        timestamp: Number(row.timestamp),
        ...(transport ? { transport } : {}),
        details: sanitize(JSON.parse(details) as unknown),
      };
    });
    if (generation !== clearGeneration) return getEventLog();
    const merged = new Map(entries.map((entry) => [entry.id, entry]));
    persisted.forEach((entry) => {
      if (!merged.has(entry.id)) merged.set(entry.id, entry);
    });
    entries = [...merged.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_ENTRIES);
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

export function resetEventLogForTesting(): void {
  clearGeneration += 1;
  entries = [];
  sequence = 0;
  writesSinceTrim = 0;
  persistenceQueue = Promise.resolve();
  listeners.clear();
}
