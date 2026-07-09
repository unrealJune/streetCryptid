import type { MapGeometry } from '../core/types';
import type { GeometrySource } from './geometry-source';
import { tileKeyOf, type TileCoord, type TileKey } from './tile-math';

/**
 * LRU cache + in-flight de-duplication around any {@link GeometrySource}.
 * Decoded tiles are immutable, so sharing them between callers is safe.
 * Failed fetches are not cached; the next request retries.
 */
export class CachedGeometrySource implements GeometrySource {
  private readonly cache = new Map<TileKey, MapGeometry>();
  private readonly inFlight = new Map<TileKey, Promise<MapGeometry>>();

  constructor(
    private readonly upstream: GeometrySource,
    private readonly capacity = 64
  ) {}

  has(tile: TileCoord): boolean {
    return this.cache.has(tileKeyOf(tile.z, tile.x, tile.y));
  }

  getTile(tile: TileCoord, signal?: AbortSignal): Promise<MapGeometry> {
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
