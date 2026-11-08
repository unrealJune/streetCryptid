/**
 * The SQLite trail storage, run against a real SQLite engine (`node:sqlite`) rather than a fake.
 *
 * `SqliteTrailStorage.putFriendLatest` carries the last-write-wins rule and the provenance merge in
 * one `ON CONFLICT` clause, and `InMemoryTrailStorage` is its hand-written mirror. Every other test
 * exercises only the mirror, so a drift between the two would ship unnoticed: this suite replays
 * every short sequence of writes against both and requires the same rows back. It also covers the
 * open-time migration that clears labels from transports that no longer exist.
 *
 * Skipped where the runtime has no `node:sqlite` (Node < 22.13 without a flag).
 */
import type { TrailPoint, TrailStorage } from '../background/trail-store';

interface RawStatement {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): RawStatement;
}

const nodeSqlite: { DatabaseSync: new (path: string) => RawDb } | null = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional runtime builtin
    return require('node:sqlite');
  } catch {
    return null;
  }
})();

let mockRawDb: RawDb | null = null;

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: async () => {
    const db = mockRawDb;
    if (!db) throw new Error('no database seeded for this test');
    return {
      execAsync: async (sql: string) => {
        db.exec(sql);
      },
      runAsync: async (sql: string, ...params: unknown[]) => ({
        changes: Number(db.prepare(sql).run(...params).changes),
      }),
      getFirstAsync: async (sql: string, ...params: unknown[]) =>
        db.prepare(sql).get(...params) ?? null,
      getAllAsync: async (sql: string, ...params: unknown[]) => db.prepare(sql).all(...params),
    };
  },
}));

/** A fresh database and a freshly evaluated persistence module (its open promise is cached). */
function openStorage(seed?: (db: RawDb) => void): { db: RawDb; storage: TrailStorage } {
  const db = new nodeSqlite!.DatabaseSync(':memory:');
  seed?.(db);
  mockRawDb = db;
  let storage!: TrailStorage;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- fresh module per database
    const persistence = require('../persistence') as typeof import('../persistence');
    storage = persistence.createPersistentTrailStorage();
  });
  return { db, storage };
}

function loadInMemory(): typeof import('../background/trail-store') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- same module the SUT uses
  return require('../background/trail-store');
}

const PEER_A = 'aa'.repeat(32);
const PEER_B = 'bb'.repeat(32);

const LEGACY_SCHEMA = `CREATE TABLE friend_latest (
  author TEXT PRIMARY KEY NOT NULL,
  seq INTEGER NOT NULL,
  fix TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  fix_ts INTEGER NOT NULL,
  via TEXT
)`;

function legacyRow(db: RawDb, author: string, via: string | null, viaPeer?: string): void {
  db.prepare(
    `INSERT INTO friend_latest (author, seq, fix, received_at, fix_ts, via${viaPeer ? ', via_peer' : ''})
     VALUES (?, 1, ?, 0, 100, ?${viaPeer ? ', ?' : ''})`
  ).run(
    author,
    JSON.stringify({ lat: 1, lon: 2, accuracyM: 5, headingDeg: 0, ts: 100 }),
    via,
    ...(viaPeer ? [viaPeer] : [])
  );
}

const maybe = nodeSqlite ? describe : describe.skip;

afterEach(() => {
  mockRawDb = null;
});

maybe('SQLite trail storage', () => {
  it('clears provenance from transports that no longer exist when it opens', async () => {
    const { db, storage } = openStorage((raw) => {
      raw.exec(LEGACY_SCHEMA);
      raw.exec('ALTER TABLE friend_latest ADD COLUMN via_peer TEXT');
      legacyRow(raw, 'relayed', 'relay', PEER_A);
      legacyRow(raw, 'live', 'live');
      legacyRow(raw, 'ble', 'ble', PEER_B);
      legacyRow(raw, 'stashed', 'stash', PEER_A);
      legacyRow(raw, 'replicated', 'docs', PEER_B);
      legacyRow(raw, 'read-back', 'sync');
      legacyRow(raw, 'unlabelled', null);
    });

    const byAuthor = new Map((await storage.friendLatest()).map((p) => [p.author, p]));
    expect(byAuthor.size).toBe(7);
    for (const author of ['relayed', 'live', 'ble', 'stashed', 'unlabelled']) {
      expect(byAuthor.get(author)?.via).toBeUndefined();
      expect(byAuthor.get(author)?.viaPeer).toBeUndefined();
    }
    expect(byAuthor.get('replicated')).toMatchObject({ via: 'docs', viaPeer: PEER_B });
    expect(byAuthor.get('read-back')?.via).toBe('sync');

    // Cleared on disk too, so the ON CONFLICT merge (which compares the stored label) sees a row
    // with no provenance and lets the next delivery's label in.
    const stale = db
      .prepare(`SELECT author FROM friend_latest WHERE via NOT IN ('docs', 'sync')`)
      .all();
    expect(stale).toEqual([]);
    const strayPeers = db
      .prepare('SELECT author FROM friend_latest WHERE via IS NULL AND via_peer IS NOT NULL')
      .all();
    expect(strayPeers).toEqual([]);
  });

  it('adds the deliverer column to a table that predates it', async () => {
    const { storage } = openStorage((raw) => {
      raw.exec(LEGACY_SCHEMA);
      legacyRow(raw, 'old', 'relay');
    });

    await storage.putFriendLatest({
      author: 'old',
      seq: 2,
      fix: { lat: 3, lon: 4, accuracyM: 5, headingDeg: 0, ts: 200 },
      receivedAt: 1,
      via: 'docs',
      viaPeer: PEER_A,
    });
    const [held] = await storage.friendLatest();
    expect(held).toMatchObject({ seq: 2, via: 'docs', viaPeer: PEER_A });
  });

  it('never reads a label this build cannot produce, nor the peer beside it', async () => {
    const { db, storage } = openStorage();
    // Opened (and migrated) by the first read; a row written after that bypasses the migration.
    expect(await storage.friendLatest()).toEqual([]);
    legacyRow(db, 'late', 'direct', PEER_A);

    const [held] = await storage.friendLatest();
    expect(held.author).toBe('late');
    expect(held.via).toBeUndefined();
    expect(held.viaPeer).toBeUndefined();
  });

  /**
   * Every sequence of three writes over a small alphabet — two timestamps, two seqs, and each
   * provenance a delivery can carry — through both implementations, one author per sequence.
   */
  it('agrees with the in-memory mirror on every short write sequence', async () => {
    const { storage: sql } = openStorage();
    const { InMemoryTrailStorage } = loadInMemory();
    const memory = new InMemoryTrailStorage();

    const provenances: Pick<TrailPoint, 'via' | 'viaPeer'>[] = [
      {},
      { via: 'sync' },
      { via: 'docs', viaPeer: PEER_A },
      { via: 'docs', viaPeer: PEER_B },
    ];
    const writes: Omit<TrailPoint, 'author' | 'receivedAt'>[] = [];
    for (const ts of [100, 200]) {
      for (const seq of [1, 2]) {
        for (const provenance of provenances) {
          writes.push({
            seq,
            fix: { lat: ts / 100, lon: seq, accuracyM: 5, headingDeg: 0, ts },
            ...provenance,
          });
        }
      }
    }

    let sequences = 0;
    let receivedAt = 0;
    for (const first of writes) {
      for (const second of writes) {
        for (const third of writes) {
          const author = `f${sequences++}`;
          for (const write of [first, second, third]) {
            const point: TrailPoint = { author, receivedAt: ++receivedAt, ...write };
            await sql.putFriendLatest(point);
            await memory.putFriendLatest(point);
          }
        }
      }
    }

    const normalise = (points: TrailPoint[]) =>
      points
        .map((p) => ({
          author: p.author,
          seq: p.seq,
          fix: p.fix,
          receivedAt: p.receivedAt,
          via: p.via ?? null,
          viaPeer: p.viaPeer ?? null,
        }))
        .sort((a, b) => a.author.localeCompare(b.author));

    const fromSql = normalise(await sql.friendLatest());
    const fromMemory = normalise(await memory.friendLatest());
    expect(fromSql).toHaveLength(sequences);
    for (let i = 0; i < sequences; i++) {
      if (JSON.stringify(fromSql[i]) !== JSON.stringify(fromMemory[i])) {
        // One readable failure instead of a 4096-row diff.
        expect(fromSql[i]).toEqual(fromMemory[i]);
      }
    }
  });
});
