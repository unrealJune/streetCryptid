import { packGeometry, unpackPacked, type PackedGeometry } from '../packed-geometry';
import type { GeometrySource } from '../geometry-source';
import { EMPTY_GEOMETRY, mergeGeometry } from '../geometry-source';
import { CachedGeometrySource } from '../tile-cache';
import type { TileCoord } from '../tile-math';

// ─── Fake upstream ─────────────────────────────────────────────────────────────

interface FakeCall {
  tile: TileCoord;
  resolve: (g: PackedGeometry) => void;
  reject: (e: unknown) => void;
}

class FakeSource implements GeometrySource {
  readonly calls: FakeCall[] = [];

  getTile(tile: TileCoord): Promise<PackedGeometry> {
    return new Promise((resolve, reject) => {
      this.calls.push({ tile, resolve, reject });
    });
  }

  /** Number of pending/completed upstream calls. */
  get callCount(): number {
    return this.calls.length;
  }

  /** Resolve the most-recent call. */
  resolveLast(g: PackedGeometry = EMPTY_GEOMETRY): void {
    const call = this.calls[this.calls.length - 1];
    if (!call) throw new Error('No pending call');
    call.resolve(g);
  }

  /** Reject the most-recent call. */
  rejectLast(e: unknown = new Error('upstream error')): void {
    const call = this.calls[this.calls.length - 1];
    if (!call) throw new Error('No pending call');
    call.reject(e);
  }
}

function makeGeometry(tag: string): PackedGeometry {
  return { ...EMPTY_GEOMETRY, places: [{ name: tag, world: [0, 0], kind: 'test' }] };
}

const T1: TileCoord = { z: 14, x: 1, y: 1 };
const T2: TileCoord = { z: 14, x: 2, y: 2 };
const T3: TileCoord = { z: 14, x: 3, y: 3 };

// ─── CachedGeometrySource ─────────────────────────────────────────────────────

describe('CachedGeometrySource — deduplication', () => {
  it('concurrent requests for the same tile hit upstream only once', async () => {
    const upstream = new FakeSource();
    const cache = new CachedGeometrySource(upstream, 64);

    const p1 = cache.getTile(T1);
    const p2 = cache.getTile(T1);

    expect(upstream.callCount).toBe(1);

    upstream.resolveLast(makeGeometry('T1'));

    const [g1, g2] = await Promise.all([p1, p2]);
    expect(g1).toBe(g2); // same reference
  });
});

describe('CachedGeometrySource — cache hit', () => {
  it('a resolved tile is served from cache without another upstream call', async () => {
    const upstream = new FakeSource();
    const cache = new CachedGeometrySource(upstream, 64);

    const p1 = cache.getTile(T1);
    upstream.resolveLast(makeGeometry('T1'));
    const first = await p1;

    const second = await cache.getTile(T1);

    expect(upstream.callCount).toBe(1); // no second call
    expect(second).toBe(first); // same object
  });
});

describe('CachedGeometrySource — LRU eviction (capacity=2)', () => {
  it('requesting a 3rd tile evicts the LRU; re-requesting the evicted tile calls upstream again', async () => {
    const upstream = new FakeSource();
    const cache = new CachedGeometrySource(upstream, 2);

    // Fill cache with T1, T2
    const p1 = cache.getTile(T1);
    upstream.resolveLast(makeGeometry('T1'));
    await p1;

    const p2 = cache.getTile(T2);
    upstream.resolveLast(makeGeometry('T2'));
    await p2;

    expect(upstream.callCount).toBe(2);

    // Request T3 → evicts T1 (least recently used)
    const p3 = cache.getTile(T3);
    upstream.resolveLast(makeGeometry('T3'));
    await p3;

    expect(upstream.callCount).toBe(3);

    // Re-request T1 → cache miss, upstream called again
    const p1b = cache.getTile(T1);
    upstream.resolveLast(makeGeometry('T1-again'));
    await p1b;

    expect(upstream.callCount).toBe(4);
  });

  it('recently-used tile is kept when a newer tile causes eviction', async () => {
    const upstream = new FakeSource();
    const cache = new CachedGeometrySource(upstream, 2);

    // Fill cache T1, T2
    const p1 = cache.getTile(T1);
    upstream.resolveLast(makeGeometry('T1'));
    await p1;

    const p2 = cache.getTile(T2);
    upstream.resolveLast(makeGeometry('T2'));
    await p2;

    // Re-request T1 to mark it recently used (LRU order: T2 is now oldest)
    await cache.getTile(T1);
    expect(upstream.callCount).toBe(2); // hit from cache

    // Request T3 → evicts T2 (now the LRU)
    const p3 = cache.getTile(T3);
    upstream.resolveLast(makeGeometry('T3'));
    await p3;

    expect(upstream.callCount).toBe(3);

    // T1 is still cached — no extra upstream call
    await cache.getTile(T1);
    expect(upstream.callCount).toBe(3);

    // T2 was evicted — upstream called again
    const p2b = cache.getTile(T2);
    upstream.resolveLast(makeGeometry('T2-again'));
    await p2b;

    expect(upstream.callCount).toBe(4);
  });
});

describe('CachedGeometrySource — error not cached', () => {
  it('a rejected fetch is not cached; the next request calls upstream again', async () => {
    const upstream = new FakeSource();
    const cache = new CachedGeometrySource(upstream, 64);

    const p1 = cache.getTile(T1);
    upstream.rejectLast(new Error('network failure'));
    await expect(p1).rejects.toThrow('network failure');

    expect(upstream.callCount).toBe(1);

    // Second request should retry upstream
    const p2 = cache.getTile(T1);
    expect(upstream.callCount).toBe(2); // new upstream call

    upstream.resolveLast(makeGeometry('T1-retry'));
    const g = await p2;
    expect(g.places[0].name).toBe('T1-retry');
  });
});

describe('CachedGeometrySource — abort', () => {
  it('getTile with an already-aborted signal rejects with AbortError immediately', async () => {
    const upstream = new FakeSource();
    const cache = new CachedGeometrySource(upstream, 64);

    const ac = new AbortController();
    ac.abort();

    await expect(cache.getTile(T1, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('aborting mid-flight rejects the caller; upstream result is cached for later callers', async () => {
    const upstream = new FakeSource();
    const cache = new CachedGeometrySource(upstream, 64);

    const ac = new AbortController();
    const abortable = cache.getTile(T1, ac.signal);

    // Abort before upstream resolves
    ac.abort();

    await expect(abortable).rejects.toMatchObject({ name: 'AbortError' });

    // Upstream resolves after the abort
    upstream.resolveLast(makeGeometry('T1-late'));

    // Drain the microtask queue so the cache stores the result
    await Promise.resolve();
    await Promise.resolve();

    // A fresh request should now be served from cache (no extra upstream call)
    const fresh = await cache.getTile(T1);
    expect(upstream.callCount).toBe(1);
    expect(fresh.places[0].name).toBe('T1-late');
  });
});

// ─── mergeGeometry ────────────────────────────────────────────────────────────

describe('mergeGeometry', () => {
  it('single-part returns the same object reference', () => {
    const g = makeGeometry('solo');
    expect(mergeGeometry([g])).toBe(g);
  });

  it('EMPTY_GEOMETRY has no parts and no places', () => {
    expect(EMPTY_GEOMETRY.parts).toHaveLength(0);
    expect(EMPTY_GEOMETRY.places).toHaveLength(0);
  });

  it('merges features across multiple parts', () => {
    const street = { roadClass: 2 as const, points: [[0, 0] as const, [1, 1] as const] };
    const river = { points: [[0.1, 0.1] as const, [0.2, 0.2] as const] };
    const area = { rings: [[[0, 0] as const, [1, 0] as const, [0, 1] as const]] };
    const place1 = { name: 'A', world: [0, 0] as const, kind: 'city' };
    const place2 = { name: 'B', world: [1, 1] as const, kind: 'town' };

    const g1: PackedGeometry = packGeometry({
      streets: [street],
      rivers: [river],
      water: [],
      parks: [area],
      places: [place1],
    });
    const g2: PackedGeometry = packGeometry({
      streets: [],
      rivers: [],
      water: [area],
      parks: [],
      places: [place2],
    });

    const merged = unpackPacked(mergeGeometry([g1, g2]));
    expect(merged.streets).toHaveLength(1);
    expect(merged.rivers).toHaveLength(1);
    expect(merged.water).toHaveLength(1);
    expect(merged.parks).toHaveLength(1);
    expect(merged.places).toHaveLength(2);
    expect(merged.places.map((p) => p.name)).toEqual(['A', 'B']);
  });

  it('merging empty parts yields empty geometry', () => {
    const merged = mergeGeometry([EMPTY_GEOMETRY, EMPTY_GEOMETRY, EMPTY_GEOMETRY]);
    expect(merged.parts).toHaveLength(0);
    expect(merged.places).toHaveLength(0);
  });
});

// ─── prefetch ────────────────────────────────────────────────────────────────

describe('CachedGeometrySource.prefetch', () => {
  it('warms uncached tiles and skips ones already cached', async () => {
    const upstream = new FakeSource();
    const cache = new CachedGeometrySource(upstream, 8);

    const p1 = cache.getTile(T1);
    upstream.resolveLast(makeGeometry('T1'));
    await p1;
    expect(upstream.callCount).toBe(1);

    const pf = cache.prefetch([T1, T2]); // T1 cached → skip, T2 → warm
    await Promise.resolve();
    expect(upstream.callCount).toBe(2); // only T2 requested
    upstream.resolveLast(makeGeometry('T2'));
    await pf;
    expect(cache.has(T2)).toBe(true);
  });

  it('swallows upstream failures (best-effort)', async () => {
    const upstream = new FakeSource();
    const cache = new CachedGeometrySource(upstream, 8);
    const pf = cache.prefetch([T1]);
    await Promise.resolve();
    upstream.rejectLast(new Error('network down'));
    await expect(pf).resolves.toBeUndefined();
    expect(cache.has(T1)).toBe(false);
  });

  it('stops immediately when already aborted', async () => {
    const upstream = new FakeSource();
    const cache = new CachedGeometrySource(upstream, 8);
    const controller = new AbortController();
    controller.abort();
    await cache.prefetch([T1, T2], controller.signal);
    expect(upstream.callCount).toBe(0);
  });
});
