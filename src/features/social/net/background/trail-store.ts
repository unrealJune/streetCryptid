import type { DeliveryDetail, FixTransport, IncomingFix, LocationFix } from '../../core/types';

/**
 * Local history of location fixes — the app-side mirror of the durable iroh-docs
 * trail. Holds our own full trail (what we published) plus, for each friend, **only their most
 * recent fix**. See docs/social/ARCHITECTURE.md §5–6, §9.
 *
 * Friends' history is deliberately not retained. The map shows a friend as a single dot at their
 * latest position, so keeping the rest bought nothing and cost a great deal: docs reconciliation
 * delivers a friend's entire back-catalogue in one burst the moment it catches up, and every point
 * in it used to be decrypted, inserted, and fanned out to the UI — which re-read the whole table
 * per point. Storing only the newest fix makes that burst O(1) work, and means a friend's
 * movements are never sitting on this device in the first place.
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
  /**
   * {@link via} with the delivering peer and its open paths, when the native core supplied it.
   *
   * Bound to {@link via}: whichever writer's label {@link mergeVia} keeps, that writer's detail is
   * kept too (see {@link mergeDelivery}). Storing them independently would let the row claim one
   * delivery's transport and another's peer.
   */
  delivery?: DeliveryDetail;
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

/**
 * Keep the detail belonging to whichever label {@link mergeVia} kept, so a row never mixes one
 * delivery's transport with another's peer. Passing both sides' labels is what makes that
 * decidable — the detail alone cannot say which write won.
 */
export function mergeDelivery(
  existing: TrailPoint,
  incoming: TrailPoint
): DeliveryDetail | undefined {
  const winner = mergeVia(existing.via, incoming.via);
  // The incoming write took the label, so it owns the detail too.
  if (winner !== existing.via) return incoming.delivery;
  // The existing write kept the label. Fill a missing detail only from a write that agrees about
  // the transport — anything else would pair one delivery's label with another's peer.
  return existing.delivery ?? (incoming.via === existing.via ? incoming.delivery : undefined);
}

/** Storage port. Real impl: expo-sqlite. Tests use {@link InMemoryTrailStorage}. */
export interface TrailStorage {
  /**
   * Upsert by `(author, seq)`. An existing point's {@link TrailPoint.via} is kept: re-delivery
   * through a slower path must not rewrite how the fix originally arrived. See {@link mergeVia}
   * for the one exception.
   */
  put(point: TrailPoint): Promise<void>;
  /**
   * Store `point` and drop every other point by the same author, so exactly one — the newest —
   * survives. Used for friends, whose history is deliberately not retained.
   *
   * "Newest" is decided by `(fix.ts, seq)`, not by arrival: reconciliation routinely delivers old
   * entries after new ones, and a late-arriving stale fix must not become a friend's displayed
   * position.
   */
  putLatest(point: TrailPoint): Promise<void>;
  /** Points for `author` with `fix.ts >= sinceTs`, ascending by seq. */
  range(author: string, sinceTs: number): Promise<TrailPoint[]>;
  /** The most recent point per author (by fix.ts). */
  latest(): Promise<TrailPoint[]>;
  /** Delete every cached point for one author; returns the count removed. */
  removeAuthor(author: string): Promise<number>;
  /**
   * Collapse every author except `exceptAuthor` to their single newest point; returns the count
   * removed. One-shot migration for devices that retained friends' history before it was dropped.
   */
  collapseToLatest(exceptAuthor: string): Promise<number>;
  /** Delete points with `fix.ts < olderThanTs`; returns the count removed. */
  prune(olderThanTs: number): Promise<number>;
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
  private readonly points: TrailPoint[] = [];
  async put(point: TrailPoint): Promise<void> {
    // Upsert by (author, seq): a re-delivered fix must not duplicate, and must not relabel how the
    // fix first arrived (`refreshTrailFromReplica` re-reads every entry on every sync).
    const i = this.points.findIndex((p) => p.author === point.author && p.seq === point.seq);
    if (i >= 0) {
      const existing = this.points[i];
      const via = mergeVia(existing.via, point.via);
      const delivery = mergeDelivery(existing, point);
      this.points[i] = { ...point, ...(via ? { via } : {}), ...(delivery ? { delivery } : {}) };
    } else this.points.push(point);
  }
  async putLatest(point: TrailPoint): Promise<void> {
    await this.put(point);
    const newest = this.points
      .filter((p) => p.author === point.author)
      .reduce((best, p) => (isNewer(p, best) ? p : best));
    for (let i = this.points.length - 1; i >= 0; i--) {
      if (this.points[i].author === point.author && this.points[i] !== newest) {
        this.points.splice(i, 1);
      }
    }
  }
  async collapseToLatest(exceptAuthor: string): Promise<number> {
    const before = this.points.length;
    const newestByAuthor = new Map<string, TrailPoint>();
    for (const p of this.points) {
      if (p.author === exceptAuthor) continue;
      const current = newestByAuthor.get(p.author);
      if (!current || isNewer(p, current)) newestByAuthor.set(p.author, p);
    }
    for (let i = this.points.length - 1; i >= 0; i--) {
      const p = this.points[i];
      if (p.author !== exceptAuthor && newestByAuthor.get(p.author) !== p) this.points.splice(i, 1);
    }
    return before - this.points.length;
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
  /**
   * Record a decrypted fix received from a friend (live or backfill), keeping ONLY their newest.
   * See the module header for why a friend's history is not retained.
   */
  appendFriend(incoming: IncomingFix): Promise<void>;
  /** Ascending-by-seq points for an author at or after `sinceTs`. */
  rangeFor(author: string, sinceTs: number): Promise<TrailPoint[]>;
  /** Latest point per author. */
  latestPerAuthor(): Promise<TrailPoint[]>;
  /** Remove every cached point for one author. */
  removeAuthor(author: string): Promise<number>;
  /** Drop friends' retained history, keeping each friend's newest point. Returns points removed. */
  collapseFriendHistory(): Promise<number>;
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
      await storage.putLatest({
        author: incoming.author,
        seq: incoming.seq,
        fix: incoming.fix,
        receivedAt: incoming.receivedAt ?? now(),
        via: incoming.via ?? (incoming.backfill ? 'sync' : 'live'),
        // Only when the native core supplied it — never synthesised from the fallback label, which
        // by definition knows no peer and no paths.
        ...(incoming.delivery ? { delivery: incoming.delivery } : {}),
      });
    },
    async collapseFriendHistory(): Promise<number> {
      return storage.collapseToLatest(SELF_AUTHOR);
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
