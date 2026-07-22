import type { GeometrySource } from './geometry-source';
import type { PackedGeometry } from './packed-geometry';
import { tileKeyOf, type TileCoord, type TileKey } from './tile-math';

/**
 * LRU cache + in-flight de-duplication around any {@link GeometrySource}.
 * Decoded tiles are immutable, so sharing them between callers is safe.
 * Failed fetches are not cached; the next request retries.
 */
export class CachedGeometrySource implements GeometrySource {
  private readonly cache = new Map<TileKey, PackedGeometry>();
  private readonly inFlight = new Map<TileKey, Promise<PackedGeometry>>();

  constructor(
    private readonly upstream: GeometrySource,
    private readonly capacity = 64
  ) {}

  has(tile: TileCoord): boolean {
    return this.cache.has(tileKeyOf(tile.z, tile.x, tile.y));
  }

  /**
   * Idle prefetch: warm the cache one tile at a time so at most one bundle is
   * ever in flight (kind to a weak connection), skipping tiles already cached
   * or in flight. Best-effort — failures are swallowed — and it bails the moment
   * the signal aborts (e.g. the user starts panning again).
   */
  async prefetch(tiles: readonly TileCoord[], signal?: AbortSignal): Promise<void> {
    for (const tile of tiles) {
      if (signal?.aborted) return;
      if (this.has(tile)) continue;
      try {
        await this.getTile(tile, signal);
      } catch {
        // A failed or aborted warm is harmless; the real request will retry.
      }
    }
  }

  getTile(tile: TileCoord, signal?: AbortSignal): Promise<PackedGeometry> {
    const key = tileKeyOf(tile.z, tile.x, tile.y);

    const hit = this.cache.get(key);
    if (hit) {
      // Map iteration order is insertion order; re-inserting marks it recently used.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return Promise.resolve(hit);
    }

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    // Deliberately not passing `signal` upstream: several viewports may await the
    // same tile, and a decoded tile is worth caching even if its requester left.
    const request = this.upstream
      .getTile(tile)
      .then((geometry) => {
        this.cache.set(key, geometry);
        if (this.cache.size > this.capacity) {
          const oldest = this.cache.keys().next().value;
          if (oldest !== undefined) this.cache.delete(oldest);
        }
        return geometry;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, request);

    if (!signal) return request;
    return abortable(request, signal);
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      }
    );
  });
}

function abortError(): Error {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}
