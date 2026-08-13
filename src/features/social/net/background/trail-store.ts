import type { FixTransport, IncomingFix, LocationFix } from '../../core/types';

/**
 * Local location state — the app-side mirror of the durable iroh-docs replica. Two deliberately
 * different shapes, per `docs/social/FORWARD-SECRECY.md` §4.4 and §5.3 (see also
 * docs/social/ARCHITECTURE.md §5–6, §9):
 *
 * - **Our own trail is history** — the points we published, retained locally and bounded by a
 *   TTL. It is locally generated and never decrypted from the network, so it is the user's own
 *   data to keep.
 * - **A friend's location is a single current fix** — one row per friend, overwritten on every
 *   receipt. Received location *history* is not retained on device at all: it was the dominant
 *   term for the device-seizure threat (an adversary reads it without touching a key), and the
 *   durable transport it mirrored is itself last-write-wins now.
 *
 * The split is structural rather than a matter of pruning policy: there is no table a friend's
 * older fix could be read back out of. It also happens to be what made the post-pairing freeze
 * impossible rather than merely cheaper: docs reconciliation delivers a friend's entire
 * back-catalogue in one burst the moment it catches up, and every point in it used to be
 * decrypted, inserted, and fanned out to a UI that re-read the whole table per point.
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
  /** Append one of our own published points (upsert by `seq`). */
  putSelf(point: TrailPoint): Promise<void>;
  /** Our own points with `fix.ts >= sinceTs`, ascending by seq. */
  selfRange(sinceTs: number): Promise<TrailPoint[]>;
  /**
   * Overwrite a friend's single stored fix. Last-write-wins by `(fix.ts, seq)`: a point older than
   * the one already stored is ignored, so an out-of-order delivery — reconciliation routinely
   * delivers old entries after new ones — cannot move a friend backwards on the map.
   *
   * Re-delivery of the fix already stored is not a no-op: it still merges {@link TrailPoint.via},
   * so a precise transport label can sharpen an {@link UNRESOLVED_VIA} one. See {@link mergeVia}.
   */
  putFriendLatest(point: TrailPoint): Promise<void>;
  /** Every friend's current fix — at most one per author. */
  friendLatest(): Promise<TrailPoint[]>;
  /** Forget a friend's stored fix (revocation / removal); returns the count removed. */
  removeFriend(author: string): Promise<number>;
  /** Delete our own points with `fix.ts < olderThanTs`; returns the count removed. */
  pruneSelf(olderThanTs: number): Promise<number>;
}

/** Order two points newest-first. Ties on `fix.ts` break by `seq`, which is monotonic per author. */
function isNewer(candidate: TrailPoint, incumbent: TrailPoint): boolean {
  return (
    candidate.fix.ts > incumbent.fix.ts ||
    (candidate.fix.ts === incumbent.fix.ts && candidate.seq > incumbent.seq)
  );
}

/** In-memory {@link TrailStorage} for unit tests / no-native fallback. */
export class InMemoryTrailStorage implements TrailStorage {
  private readonly self: TrailPoint[] = [];
  private readonly friends = new Map<string, TrailPoint>();

  async putSelf(point: TrailPoint): Promise<void> {
    const i = this.self.findIndex((p) => p.seq === point.seq);
    if (i >= 0) this.self[i] = point;
    else this.self.push(point);
  }

  async selfRange(sinceTs: number): Promise<TrailPoint[]> {
    return this.self.filter((p) => p.fix.ts >= sinceTs).sort((a, b) => a.seq - b.seq);
  }

  async putFriendLatest(point: TrailPoint): Promise<void> {
    const current = this.friends.get(point.author);
    if (!current || isNewer(point, current)) {
      // A strictly newer fix supersedes the row wholesale, and its own label is the right one.
      this.friends.set(point.author, point);
      return;
    }
    // Older, or the same fix re-delivered. Either way the position must not move — but a
    // re-delivery that names the serving peer can still sharpen the label we hold. Mirrors the
    // SQLite `ON CONFLICT` clause in persistence.ts.
    if (point.seq === current.seq && point.fix.ts === current.fix.ts) {
      this.friends.set(point.author, { ...current, via: mergeVia(current.via, point.via) });
    }
  }

  async friendLatest(): Promise<TrailPoint[]> {
    return [...this.friends.values()];
  }

  async removeFriend(author: string): Promise<number> {
    return this.friends.delete(author) ? 1 : 0;
  }

  async pruneSelf(olderThanTs: number): Promise<number> {
    const before = this.self.length;
    for (let i = this.self.length - 1; i >= 0; i--) {
      if (this.self[i].fix.ts < olderThanTs) this.self.splice(i, 1);
    }
    return before - this.self.length;
  }
}

export interface TrailStore {
  /** Record one of our own published fixes (seq = the value put on the wire). */
  appendOwn(fix: LocationFix, seq: number): Promise<void>;
  /**
   * Record a friend's current position, replacing whatever we held for them. Last-write-wins by
   * `(fix.ts, seq)` — see {@link TrailStorage.putFriendLatest}.
   */
  recordFriendLatest(incoming: IncomingFix): Promise<void>;
  /** Our own retained trail at or after `sinceTs`, ascending by seq. */
  selfTrail(sinceTs?: number): Promise<TrailPoint[]>;
  /** Every friend's current fix — at most one per friend. */
  friendLatest(): Promise<TrailPoint[]>;
  /** Forget a friend's stored fix. */
  removeFriend(author: string): Promise<number>;
  /** Delete our own points older than `olderThanTs`; returns points removed. */
  pruneSelf(olderThanTs: number): Promise<number>;
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
      await storage.putSelf({ author: SELF_AUTHOR, seq, fix, receivedAt: now() });
    },
    async recordFriendLatest(incoming: IncomingFix): Promise<void> {
      await storage.putFriendLatest({
        author: incoming.author,
        seq: incoming.seq,
        fix: incoming.fix,
        receivedAt: incoming.receivedAt ?? now(),
        via: incoming.via ?? (incoming.backfill ? 'sync' : 'live'),
      });
    },
    async selfTrail(sinceTs = 0): Promise<TrailPoint[]> {
      return storage.selfRange(sinceTs);
    },
    async friendLatest(): Promise<TrailPoint[]> {
      return storage.friendLatest();
    },
    async removeFriend(author: string): Promise<number> {
      return storage.removeFriend(author);
    },
    async pruneSelf(olderThanTs: number): Promise<number> {
      return storage.pruneSelf(olderThanTs);
    },
  };
}
