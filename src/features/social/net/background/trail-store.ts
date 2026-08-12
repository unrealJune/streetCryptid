import type { FixTransport, IncomingFix, LocationFix } from '../../core/types';

/**
 * Local history of location fixes — the app-side mirror of the durable iroh-docs
 * trail. Holds our own trail (what we published) plus friends' trails (live + backfilled from
 * docs range-reconciliation). The same complete history powers a selected friend's map breadcrumb
 * and profile timeline while still letting a rejoining peer recover what it missed.
 * See docs/social/ARCHITECTURE.md §5–6, §9.
 */

/** Sentinel author id for our own trail points. */
export const SELF_AUTHOR = 'self';

export interface TrailPoint {
  /** {@link SELF_AUTHOR} for our own points, else the friend's endpointId (hex). */
  author: string;
  /** The author's monotonic publish counter (matches the on-wire envelope `seq`). */
  seq: number;
  fix: LocationFix;
  /** ms epoch this device stored the point. */
  receivedAt: number;
  /**
   * How the point reached this device (friend points only; our own are unlabelled). Absent on rows
   * stored before provenance was recorded.
   *
   * First writer wins: a fix received live and later re-seen during reconciliation keeps its live
   * label, because that is how it actually got here. The one exception is
   * {@link UNRESOLVED_VIA} — see {@link mergeVia}.
   */
  via?: FixTransport;
}

/**
 * The label derived from the `backfill` flag alone, when the delivery carried none: "read back out
 * of the durable replica, serving peer unknown".
 *
 * It is deliberately weaker than every label the native layer supplies, because
 * `refreshTrailFromReplica` re-reads the whole replica after each sync and can beat the backfill
 * callback that carries the precise one (`stash` vs `docs`) to the store.
 */
export const UNRESOLVED_VIA: FixTransport = 'sync';

/**
 * Provenance kept on upsert: first writer wins, except that {@link UNRESOLVED_VIA} yields to any
 * label that actually names the serving peer or link. Mirrored in the SQLite `ON CONFLICT` clause.
 */
export function mergeVia(
  existing: FixTransport | undefined,
  incoming: FixTransport | undefined
): FixTransport | undefined {
  if (!existing) return incoming;
  if (existing === UNRESOLVED_VIA && incoming && incoming !== UNRESOLVED_VIA) return incoming;
  return existing;
}

/** Storage port. Real impl: expo-sqlite. Tests use {@link InMemoryTrailStorage}. */
export interface TrailStorage {
  /**
   * Upsert by `(author, seq)`. An existing point's {@link TrailPoint.via} is kept: re-delivery
   * through a slower path must not rewrite how the fix originally arrived. See {@link mergeVia}
   * for the one exception.
   */
  put(point: TrailPoint): Promise<void>;
  /** Points for `author` with `fix.ts >= sinceTs`, ascending by seq. */
  range(author: string, sinceTs: number): Promise<TrailPoint[]>;
  /** The most recent point per author (by fix.ts). */
  latest(): Promise<TrailPoint[]>;
  /** Delete every cached point for one author; returns the count removed. */
  removeAuthor(author: string): Promise<number>;
  /** Delete points with `fix.ts < olderThanTs`; returns the count removed. */
  prune(olderThanTs: number): Promise<number>;
}

/** In-memory {@link TrailStorage} for unit tests / no-native fallback. */
export class InMemoryTrailStorage implements TrailStorage {
  private readonly points: TrailPoint[] = [];
  async put(point: TrailPoint): Promise<void> {
    // Upsert by (author, seq): a re-delivered fix must not duplicate, and must not relabel how the
    // fix first arrived (`refreshTrailFromReplica` re-reads every entry on every sync).
    const i = this.points.findIndex((p) => p.author === point.author && p.seq === point.seq);
    if (i >= 0) this.points[i] = { ...point, via: mergeVia(this.points[i].via, point.via) };
    else this.points.push(point);
  }
  async range(author: string, sinceTs: number): Promise<TrailPoint[]> {
    return this.points
      .filter((p) => p.author === author && p.fix.ts >= sinceTs)
      .sort((a, b) => a.seq - b.seq);
  }
  async latest(): Promise<TrailPoint[]> {
    const byAuthor = new Map<string, TrailPoint>();
    for (const p of this.points) {
      const cur = byAuthor.get(p.author);
      if (!cur || p.fix.ts > cur.fix.ts) byAuthor.set(p.author, p);
    }
    return [...byAuthor.values()];
  }
  async removeAuthor(author: string): Promise<number> {
    const before = this.points.length;
    for (let i = this.points.length - 1; i >= 0; i--) {
      if (this.points[i].author === author) this.points.splice(i, 1);
    }
    return before - this.points.length;
  }
  async prune(olderThanTs: number): Promise<number> {
    const before = this.points.length;
    for (let i = this.points.length - 1; i >= 0; i--) {
      if (this.points[i].fix.ts < olderThanTs) this.points.splice(i, 1);
    }
    return before - this.points.length;
  }
}

export interface TrailStore {
  /** Record one of our own published fixes (seq = the value put on the wire). */
  appendOwn(fix: LocationFix, seq: number): Promise<void>;
  /** Record a decrypted fix received from a friend (live or backfill). */
  appendFriend(incoming: IncomingFix): Promise<void>;
  /** Ascending-by-seq points for an author at or after `sinceTs`. */
  rangeFor(author: string, sinceTs: number): Promise<TrailPoint[]>;
  /** Latest point per author. */
  latestPerAuthor(): Promise<TrailPoint[]>;
  /** Remove every cached point for one author. */
  removeAuthor(author: string): Promise<number>;
  /** Explicitly delete points older than `olderThanTs`; returns points removed. */
  prune(olderThanTs: number): Promise<number>;
}

export interface TrailStoreOptions {
  storage: TrailStorage;
  /** Injectable clock. Default `Date.now`. */
  now?: () => number;
}

export function createTrailStore(opts: TrailStoreOptions): TrailStore {
  const { storage } = opts;
  const now = opts.now ?? Date.now;

  return {
    async appendOwn(fix: LocationFix, seq: number): Promise<void> {
      await storage.put({ author: SELF_AUTHOR, seq, fix, receivedAt: now() });
    },
    async appendFriend(incoming: IncomingFix): Promise<void> {
      await storage.put({
        author: incoming.author,
        seq: incoming.seq,
        fix: incoming.fix,
        receivedAt: incoming.receivedAt ?? now(),
        via: incoming.via ?? (incoming.backfill ? 'sync' : 'live'),
      });
    },
    async rangeFor(author: string, sinceTs: number): Promise<TrailPoint[]> {
      return storage.range(author, sinceTs);
    },
    async latestPerAuthor(): Promise<TrailPoint[]> {
      return storage.latest();
    },
    async removeAuthor(author: string): Promise<number> {
      return storage.removeAuthor(author);
    },
    async prune(olderThanTs: number): Promise<number> {
      return storage.prune(olderThanTs);
    },
  };
}
