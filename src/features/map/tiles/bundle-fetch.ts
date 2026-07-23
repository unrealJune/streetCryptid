import {
  bundleKeyOf,
  bundleRequestFor,
  validateTileBundleEntries,
  type TileBundleSource,
} from './tile-bundle';
import type { StoredTile, TileByteSource, TileByteStore } from './tile-bytes';
import { tileKeyOf, type TileCoord, type TileKey } from './tile-math';
import {
  addMapPerfMetric,
  captureMapPerfMetricScope,
  perfNow,
  type MapPerfMetricScope,
} from '../perf/map-perf';

/**
 * Privacy-quantized tile fetching with one fixed-anchor bundle request. Fine
 * child coordinates never leave the app: a z11–14 miss requests the complete
 * descendant set under its `anchorZoom` ancestor and persists every member.
 * Coarse tiles at or below the anchor continue through ordinary XYZ requests.
 */
export interface BundleFetchOptions {
  readonly coarseUpstream: TileByteSource;
  readonly bundleUpstream: TileBundleSource;
  readonly store: TileByteStore;
  /** Namespaces rows in the shared store across tileset revisions. */
  readonly sourceId: string;
  /** Finest ancestor the server may learn (z10 → ~25 km around Seattle). */
  readonly anchorZoom: number;
  /** Persisted tiles older than this are refetched (whole bundle again). */
  readonly ttlMs: number;
  /** Injectable clock for tests. */
  readonly now?: () => number;
}

/**
 * Fresh store hit → zero network; fine miss/stale → one bundle request, validate
 * and persist ALL descendants (including empties), serve the requested tile.
 * Coarse misses use one ordinary XYZ request. Failures fall back to a stale copy
 * when one exists. Concurrent requests within one bundle share the same fetch.
 */
export class BundleFetchByteSource implements TileByteSource {
  private readonly inFlight = new Map<string, Promise<Map<TileKey, Uint8Array | null>>>();
  private readonly now: () => number;

  constructor(private readonly opts: BundleFetchOptions) {
    this.now = opts.now ?? Date.now;
  }

  // `signal` is accepted but not honored: bundle members are shared across
  // callers and worth persisting even if the original requester left —
  // the same reasoning as CachedGeometrySource not forwarding its signal.
  async getTileBytes(tile: TileCoord): Promise<Uint8Array | null> {
    const metrics = captureMapPerfMetricScope();
    const storeStarted = metrics ? perfNow() : 0;
    const stored = await this.opts.store.get(this.opts.sourceId, tile);
    if (metrics) addMapPerfMetric('storeReadMs', perfNow() - storeStarted, metrics);
    if (stored && this.isFresh(stored)) {
      addMapPerfMetric('storeFreshHits', 1, metrics);
      return stored.bytes;
    }
    addMapPerfMetric(stored ? 'storeStaleHits' : 'storeMisses', 1, metrics);

    try {
      const fetched =
        tile.z <= this.opts.anchorZoom
          ? await this.fetchCoarseTile(tile, metrics)
          : await this.fetchBundle(tile, metrics);
      return fetched.get(tileKeyOf(tile.z, tile.x, tile.y)) ?? null;
    } catch (e) {
      // Stale beats blank when the network is down.
      if (stored) return stored.bytes;
      throw e;
    }
  }

  private isFresh(stored: StoredTile): boolean {
    return this.now() - stored.fetchedAt <= this.opts.ttlMs;
  }

  private fetchCoarseTile(
    tile: TileCoord,
    metrics: MapPerfMetricScope | null
  ): Promise<Map<TileKey, Uint8Array | null>> {
    const tileKey = tileKeyOf(tile.z, tile.x, tile.y);
    const key = `tile:${tileKey}`;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    addMapPerfMetric('coarseRequests', 1, metrics);

    const request = this.opts.coarseUpstream
      .getTileBytes(tile)
      .then(async (bytes) => {
        const storeStarted = metrics ? perfNow() : 0;
        await this.opts.store.putMany(this.opts.sourceId, [{ tile, bytes }], this.now());
        if (metrics) addMapPerfMetric('storeWriteMs', perfNow() - storeStarted, metrics);
        return new Map([[tileKey, bytes]]);
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, request);
    return request;
  }

  private fetchBundle(
    tile: TileCoord,
    metrics: MapPerfMetricScope | null
  ): Promise<Map<TileKey, Uint8Array | null>> {
    const bundleRequest = bundleRequestFor(tile, this.opts.anchorZoom);
    const key = `bundle:${bundleKeyOf(bundleRequest)}`;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    addMapPerfMetric('bundleRequests', 1, metrics);

    const request = this.opts.bundleUpstream
      .getBundle(bundleRequest)
      .then(async (entries) => {
        validateTileBundleEntries(bundleRequest, entries);
        const storeStarted = metrics ? perfNow() : 0;
        await this.opts.store.putMany(this.opts.sourceId, entries, this.now());
        if (metrics) addMapPerfMetric('storeWriteMs', perfNow() - storeStarted, metrics);
        return new Map(entries.map((e) => [tileKeyOf(e.tile.z, e.tile.x, e.tile.y), e.bytes]));
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, request);
    return request;
  }
}
