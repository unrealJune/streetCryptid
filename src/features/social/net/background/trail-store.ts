import type { IncomingFix, LocationFix } from '../../core/types';

/**
 * Local, bounded rolling buffer of location fixes — the app-side mirror of the durable iroh-docs
 * trail. Holds our own trail (what we published) plus friends' trails (live + backfilled from
 * docs range-reconciliation). This is a **recovery buffer**, not a rendered breadcrumb: the map
 * shows only the latest point per author (DESIGN's "no path trace" principle), but the buffer
 * lets a rejoining peer recover what it missed. See docs/social/ARCHITECTURE.md §5–6, §9.
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
}

/** Storage port. Real impl: expo-sqlite. Tests use {@link InMemoryTrailStorage}. */
export interface TrailStorage {
  put(point: TrailPoint): Promise<void>;
  /** Points for `author` with `fix.ts >= sinceTs`, ascending by seq. */
  range(author: string, sinceTs: number): Promise<TrailPoint[]>;
  /** The most recent point per author (by fix.ts). */
  latest(): Promise<TrailPoint[]>;
  /** Delete points with `fix.ts < olderThanTs`; returns the count removed. */
  prune(olderThanTs: number): Promise<number>;
}

/** In-memory {@link TrailStorage} for unit tests / no-native fallback. */
export class InMemoryTrailStorage implements TrailStorage {
  private readonly points: TrailPoint[] = [];
  async put(point: TrailPoint): Promise<void> {
    // Upsert by (author, seq): a re-delivered fix must not duplicate.
    const i = this.points.findIndex((p) => p.author === point.author && p.seq === point.seq);
    if (i >= 0) this.points[i] = point;
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
  /** Ascending-by-seq points for an author within the rolling window. */
  rangeFor(author: string, sinceTs: number): Promise<TrailPoint[]>;
  /** Latest point per author — what the map renders. */
  latestPerAuthor(): Promise<TrailPoint[]>;
  /** Enforce the rolling window now; returns points removed. */
  prune(olderThanTs?: number): Promise<number>;
}

export interface TrailStoreOptions {
  storage: TrailStorage;
  /** Rolling retention window. Default 48h (ARCHITECTURE §5). */
  windowMs?: number;
  /** Injectable clock. Default `Date.now`. */
  now?: () => number;
}

const DEFAULT_WINDOW_MS = 48 * 60 * 60 * 1000;

export function createTrailStore(opts: TrailStoreOptions): TrailStore {
  const { storage } = opts;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
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
      });
    },
    async rangeFor(author: string, sinceTs: number): Promise<TrailPoint[]> {
      return storage.range(author, sinceTs);
    },
    async latestPerAuthor(): Promise<TrailPoint[]> {
      return storage.latest();
    },
    async prune(olderThanTs?: number): Promise<number> {
      const threshold = olderThanTs ?? now() - windowMs;
      return storage.prune(threshold);
    },
  };
}
