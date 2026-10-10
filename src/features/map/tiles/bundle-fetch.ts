import {
  bundleKeyOf,
  bundleRequestFor,
  TILE_BUNDLE_MAX_ZOOM,
  validateTileBundleEntries,
  type StreamStage,
  type TileBundleSource,
  type TileBundleEntry,
} from './tile-bundle';
import type {
  PreviewStageListener,
  SingleTileByteSource,
  StoredTile,
  TileByteSource,
  TileByteStore,
} from './tile-bytes';
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
  readonly coarseUpstream: SingleTileByteSource;
  readonly bundleUpstream: TileBundleSource;
  readonly store: TileByteStore;
  /** Namespaces rows in the shared store across tileset revisions. */
  readonly sourceId: string;
  /** Earlier namespaces nothing reads any more; deleted once, in the background. */
  readonly retiredSourceIds?: readonly string[];
  /** Finest ancestor the server may learn (z10 → ~25 km around Seattle). */
  readonly anchorZoom: number;
  /** Persisted tiles older than this are refetched (whole bundle again). */
  readonly ttlMs: number;
  /** Injectable clock for tests. */
  readonly now?: () => number;
}

/** A tile's decodable parts; `null` is a known-empty tile. */
type TileParts = readonly Uint8Array[] | null;

interface StoredParts {
  readonly parts: TileParts;
  readonly fresh: boolean;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** One preview stage of one stream; resolves `null` when it will not come. */
type PreviewStage = Deferred<readonly TileBundleEntry[] | null>;

/** The coarse stages one z14 stream delivers before its last stage. */
interface PreviewStages {
  readonly overview: PreviewStage;
  readonly structure: PreviewStage;
}

const OVERVIEW_STAGE: StreamStage = { tileZoom: 13, part: 'full' };
const STRUCTURE_STAGE: StreamStage = { tileZoom: 14, part: 'structure' };

function partsOf(...bytes: (Uint8Array | null | undefined)[]): TileParts {
  const parts = bytes.filter((b): b is Uint8Array => !!b && b.byteLength > 0);
  return parts.length ? parts : null;
}

/**
 * Fresh store hit → zero network; fine miss/stale → one bundle request, validate
 * and persist ALL descendants (including empties), serve the requested tile.
 * Coarse misses use one ordinary XYZ request. Failures fall back to a stale copy
 * when one exists. Concurrent requests within one bundle share the same fetch.
 *
 * A z14 tile is stored as two rows: its `structure` part under `sourceId` and
 * its `labels` part under `${sourceId}#labels` (SCB3 ships them as separate
 * stages). It is a hit only when BOTH rows are present and fresh, so a decoded
 * z14 tile is always complete; a z14 stage that arrives whole (SCB2/SCB1) lands
 * in the structure row beside an empty labels row.
 */
export class BundleFetchByteSource implements TileByteSource {
  private readonly inFlight = new Map<string, Promise<Map<TileKey, TileParts>>>();
  private readonly now: () => number;
  private readonly previews = new Map<string, PreviewStages>();
  private readonly labelsSourceId: string;
  private retired = false;

  constructor(private readonly opts: BundleFetchOptions) {
    this.now = opts.now ?? Date.now;
    this.labelsSourceId = `${opts.sourceId}#labels`;
  }

  // `signal` is accepted but not honored: bundle members are shared across
  // callers and worth persisting even if the original requester left —
  // the same reasoning as CachedGeometrySource not forwarding its signal.
  async getTileBytes(tile: TileCoord): Promise<TileParts> {
    this.retireOldSources();
    const metrics = captureMapPerfMetricScope();
    const storeStarted = metrics ? perfNow() : 0;
    const stored = await this.readStored(tile);
    if (metrics) addMapPerfMetric('storeReadMs', perfNow() - storeStarted, metrics);
    if (stored?.fresh) {
      addMapPerfMetric('storeFreshHits', 1, metrics);
      return stored.parts;
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
      if (stored) return stored.parts;
      throw e;
    }
  }

  private retireOldSources() {
    if (this.retired) return;
    this.retired = true;
    for (const id of this.opts.retiredSourceIds ?? []) {
      // Nothing reads these rows; deleting them only returns space to the LRU cap.
      void this.opts.store.deleteSource?.(id).catch(() => {});
    }
  }

  private isFresh(stored: StoredTile): boolean {
    return this.now() - stored.fetchedAt <= this.opts.ttlMs;
  }

  private async readStored(tile: TileCoord): Promise<StoredParts | null> {
    const split = tile.z === TILE_BUNDLE_MAX_ZOOM;
    const [structure, labels] = await Promise.all([
      this.opts.store.get(this.opts.sourceId, tile),
      split ? this.opts.store.get(this.labelsSourceId, tile) : null,
    ]);
    if (!structure) return null;
    // A structure row without its labels row is usable offline, never fresh.
    const complete = !split || labels !== null;
    return {
      parts: partsOf(structure.bytes, labels?.bytes),
      fresh: complete && this.isFresh(structure) && (!labels || this.isFresh(labels)),
    };
  }

  async getPreviewTiles(tiles: readonly TileCoord[], onStage: PreviewStageListener): Promise<void> {
    if (!tiles.length || tiles.some((t) => t.z !== TILE_BUNDLE_MAX_ZOOM)) return;
    const stored = await Promise.all(tiles.map((tile) => this.readStored(tile)));
    if (stored.every((row) => row?.fresh)) return;
    const bundles = new Map(
      tiles.map((tile) => [
        `bundle:${bundleKeyOf(bundleRequestFor(tile, this.opts.anchorZoom))}`,
        tile,
      ])
    );
    const streams = [...bundles].map(([key, tile]) => {
      // Shared detail requests continue even if only the preview is currently useful.
      void this.fetchBundle(tile, captureMapPerfMetricScope()).catch(() => {});
      return this.previews.get(key);
    });
    if (streams.some((stream) => !stream)) return;
    const wanted: [StreamStage, Set<TileKey>, (s: PreviewStages) => PreviewStage][] = [
      [
        OVERVIEW_STAGE,
        new Set(tiles.map((tile) => tileKeyOf(13, tile.x >> 1, tile.y >> 1))),
        (s) => s.overview,
      ],
      [
        STRUCTURE_STAGE,
        new Set(tiles.map((tile) => tileKeyOf(tile.z, tile.x, tile.y))),
        (s) => s.structure,
      ],
    ];
    for (const [stage, keys, pick] of wanted) {
      // A stage is drawn only once every covering bundle has it: half a view is not a preview.
      const stages = await Promise.all(streams.map((stream) => pick(stream!).promise));
      if (stages.some((entries) => entries === null)) return;
      await onStage(
        stage,
        stages
          .flatMap((entries) => entries ?? [])
          .filter(({ tile }) => keys.has(tileKeyOf(tile.z, tile.x, tile.y)))
      );
    }
  }

  private fetchCoarseTile(
    tile: TileCoord,
    metrics: MapPerfMetricScope | null
  ): Promise<Map<TileKey, TileParts>> {
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
        return new Map([[tileKey, partsOf(bytes)]]);
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
  ): Promise<Map<TileKey, TileParts>> {
    const bundleRequest = bundleRequestFor(tile, this.opts.anchorZoom);
    const key = `bundle:${bundleKeyOf(bundleRequest)}`;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    addMapPerfMetric('bundleRequests', 1, metrics);

    const preview: PreviewStages = { overview: deferred(), structure: deferred() };
    this.previews.set(key, preview);
    let structure: readonly TileBundleEntry[] | null = null;
    const request = this.opts.bundleUpstream
      .getBundle(bundleRequest, async (stageRequest, entries, stage) => {
        if (stage.tileZoom !== bundleRequest.tileZoom) {
          // The z13 overview that opens a z14 stream.
          validateTileBundleEntries(stageRequest, entries);
          await this.opts.store.putMany(this.opts.sourceId, entries, this.now());
          preview.overview.resolve(entries);
        } else if (stage.part === 'structure') {
          validateTileBundleEntries(bundleRequest, entries);
          await this.opts.store.putMany(this.opts.sourceId, entries, this.now());
          structure = entries;
          preview.structure.resolve(entries);
        }
        // The last stage (`full`, or `labels` after `structure`) is persisted below.
      })
      .then(async (entries) => {
        validateTileBundleEntries(bundleRequest, entries);
        const storeStarted = metrics ? perfNow() : 0;
        const split = structure;
        if (split) {
          await this.opts.store.putMany(this.labelsSourceId, entries, this.now());
        } else {
          await this.opts.store.putMany(this.opts.sourceId, entries, this.now());
          if (bundleRequest.tileZoom === TILE_BUNDLE_MAX_ZOOM) {
            // A whole z14 stage: its structure row is the entire tile.
            await this.opts.store.putMany(
              this.labelsSourceId,
              entries.map(({ tile }) => ({ tile, bytes: null })),
              this.now()
            );
          }
        }
        if (metrics) addMapPerfMetric('storeWriteMs', perfNow() - storeStarted, metrics);
        return new Map(
          entries.map((e, i) => [
            tileKeyOf(e.tile.z, e.tile.x, e.tile.y),
            split ? partsOf(split[i].bytes, e.bytes) : partsOf(e.bytes),
          ])
        );
      })
      .finally(() => {
        preview.overview.resolve(null);
        preview.structure.resolve(null);
        this.previews.delete(key);
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, request);
    return request;
  }
}
