import {
  buildCellFieldWithTiming,
  type CellFieldTiming,
  type RegionCellField,
} from '../core/cell-field';
import type { ExplorationIndex } from '../core/exploration-index';
import type { H3Grid } from '../core/h3-grid';
import { computeRegionSpec, shouldPrefetchRegion, type RegionSpec } from '../core/region';
import type { CameraState, Place, Viewport, WorldPoint, WorldRect } from '../core/types';
import type { GeometrySource } from '../tiles/geometry-source';
import { mergeGeometry } from '../tiles/geometry-source';
import type { PackedGeometry } from '../tiles/packed-geometry';
import { tileKeyOf, tilesCovering, type DataZoomRange, type TileCoord } from '../tiles/tile-math';

/** Complete fields are large; retain only the camera regions most likely to be revisited. */
const CELL_FIELD_CACHE_CAPACITY = 8;

/** Everything a region build depends on besides the engine's own wiring. */
export interface RegionRequest {
  readonly camera: CameraState;
  readonly viewport: Viewport;
  readonly exploration: ExplorationIndex;
  /** Monotonic revision of the mutable exploration index. */
  readonly explorationVersion: number;
}

/**
 * A built data region: the textures + metadata the GPU dot-field shader needs
 * to render every frame without further CPU work. Palette-independent — theme
 * switches only swap the tiny LUT, never rebuild a region.
 */
export interface MapRegion {
  readonly spec: RegionSpec;
  /**
   * Raw geometry for the region. The feature mask is now rasterized on the GPU
   * in the render layer (`buildMaskImage`) instead of on the JS thread, so the
   * region carries geometry rather than a packed pixel buffer.
   */
  readonly geometry: PackedGeometry;
  /** Exploration cells at the region's ladder rung, annotated for rendering. */
  readonly cellField: RegionCellField;
  /** Named places inside the region (island headline lookup). */
  readonly places: readonly Place[];
  /** Phase-level timings captured when this immutable region was built. */
  readonly timing: RegionTiming;
}

/** Per-build timing breakdown, for dev logging / perf tracking. */
export interface RegionTiming {
  readonly tiles: number;
  readonly coldStart: boolean;
  readonly cellFieldCacheHit: boolean;
  /** Tile source work, including byte cache/network and decode. */
  readonly sourceMs: number;
  /** Struct-of-arrays concatenation after all tiles land. */
  readonly mergeMs: number;
  /** H3 enumeration, immutable geometry lookup, and exploration annotation. */
  readonly cellFieldMs: number;
  readonly cellEnumerateMs: number;
  readonly cellCentersMs: number;
  readonly cellAnnotateMs: number;
  readonly totalMs: number;
  /** Backward-compatible aggregate: source + merge. */
  readonly fetchMs: number;
  /** Backward-compatible aggregate: H3 cell-field construction. */
  readonly buildMs: number;
}

/**
 * Live progress of one region build, for the loading reveal. Emitted once at
 * `loaded: 0` the moment the build starts (carrying `coldStart` + `rect` so the
 * caller can raise a skeleton over a would-be-blank area) and again as each tile
 * lands. `coldStart` is decided up front from the cache: false when every tile
 * is already decoded (a warm swap — the caller keeps the cheap crossfade), true
 * when at least one tile needs a fetch/decode (the reveal wipe is worth playing).
 */
export interface BuildProgress {
  readonly rect: WorldRect;
  readonly loaded: number;
  readonly total: number;
  readonly coldStart: boolean;
}

/** Notified as a build advances; see {@link BuildProgress}. */
export type BuildProgressListener = (progress: BuildProgress) => void;

export interface MapEngineOptions {
  readonly source: GeometrySource;
  readonly grid: H3Grid;
  /** The tileset's data zoom range. */
  readonly dataZooms: DataZoomRange;
  /** Called after each completed build. */
  readonly onTiming?: (timing: RegionTiming) => void;
}

/**
 * Region builder with a one-deep pipeline: at most one build runs at a time,
 * and at most one request waits behind it (a newer request replaces the waiting
 * one, which resolves null). Started builds always run to completion and land —
 * never aborted — so continuous movement (which requests regions faster than
 * they build) still lands a fresh region every build interval instead of
 * starving behind its own prefetches. The freshest request is never more than
 * one build behind. Failures degrade to the last good region instead of
 * blanking the map.
 */
export class MapEngine {
  private readonly source: GeometrySource;
  private readonly grid: H3Grid;
  private readonly dataZooms: DataZoomRange;
  private readonly onTiming?: (timing: RegionTiming) => void;

  private busy = false;
  private queued: {
    request: RegionRequest;
    onProgress?: BuildProgressListener;
    resolve: (region: MapRegion | null) => void;
    reject: (error: unknown) => void;
  } | null = null;
  private last: MapRegion | null = null;
  private readonly cellFieldCache = new Map<string, RegionCellField>();

  constructor(options: MapEngineOptions) {
    this.source = options.source;
    this.grid = options.grid;
    this.dataZooms = options.dataZooms;
    this.onTiming = options.onTiming;
  }

  get lastRegion(): MapRegion | null {
    return this.last;
  }

  /**
   * Build (or enqueue) a region for `request`. Resolves with the built region,
   * the last good region on failure, or null if a newer request replaced this
   * one while it waited in the queue. `onProgress` (if given) fires only for the
   * build that actually runs — a superseded (queued-then-replaced) request never
   * emits, so its skeleton/reveal is never raised.
   */
  buildRegion(
    request: RegionRequest,
    onProgress?: BuildProgressListener
  ): Promise<MapRegion | null> {
    if (this.busy) {
      this.queued?.resolve(null); // superseded while waiting
      return new Promise((resolve, reject) => {
        this.queued = { request, onProgress, resolve, reject };
      });
    }
    return this.runBuild(request, onProgress);
  }

  /**
   * Idle prefetch: warm the tile cache for the regions just beyond the current
   * view (the four cardinal neighbors, one region-step out) so a pan lands on a
   * cache hit instead of a blank fetch. Bounded and cancellable via `signal`;
   * a no-op when the source can't prefetch (offline fixtures). Runs entirely
   * outside the build pipeline, so it never delays an on-demand region build.
   */
  async prefetchAround(
    camera: CameraState,
    viewport: Viewport,
    signal?: AbortSignal
  ): Promise<void> {
    if (!this.source.prefetch) return;
    const spec = computeRegionSpec(camera, viewport, { dataZooms: this.dataZooms });
    const w = spec.rect.maxX - spec.rect.minX;
    const h = spec.rect.maxY - spec.rect.minY;
    const [cx, cy] = camera.center;

    const seen = new Set<string>();
    for (const t of tilesCovering(spec.rect, spec.tileZoom)) seen.add(tileKeyOf(t.z, t.x, t.y));

    const tiles: TileCoord[] = [];
    for (const [dx, dy] of [
      [w, 0],
      [-w, 0],
      [0, h],
      [0, -h],
    ] as const) {
      const center: WorldPoint = [cx + dx, cy + dy];
      const nSpec = computeRegionSpec({ center, zoom: camera.zoom }, viewport, {
        dataZooms: this.dataZooms,
      });
      for (const t of tilesCovering(nSpec.rect, nSpec.tileZoom)) {
        const key = tileKeyOf(t.z, t.x, t.y);
        if (!seen.has(key)) {
          seen.add(key);
          tiles.push(t);
        }
      }
    }
    await this.source.prefetch(tiles, signal);
  }

  /**
   * Idle prefetch of specific world points (friends' locations) at the current
   * zoom, so tapping through to a friend — which remounts the map centered on
   * them — lands on a cache hit instead of a cold fetch. `points` is expected
   * pre-ordered/capped by the caller (selected friend first, then nearest);
   * tiles are deduped across points so overlapping friends cost nothing extra.
   * Shares `prefetchAround`'s guarantees: one bundle in flight, cancels on
   * `signal`, a no-op when the source can't prefetch.
   */
  async prefetchPoints(
    points: readonly WorldPoint[],
    zoom: number,
    viewport: Viewport,
    signal?: AbortSignal
  ): Promise<void> {
    if (!this.source.prefetch || points.length === 0) return;

    const seen = new Set<string>();
    const tiles: TileCoord[] = [];
    for (const center of points) {
      if (signal?.aborted) return;
      const spec = computeRegionSpec({ center, zoom }, viewport, { dataZooms: this.dataZooms });
      for (const t of tilesCovering(spec.rect, spec.tileZoom)) {
        const key = tileKeyOf(t.z, t.x, t.y);
        if (!seen.has(key)) {
          seen.add(key);
          tiles.push(t);
        }
      }
    }
    await this.source.prefetch(tiles, signal);
  }

  private async runBuild(
    request: RegionRequest,
    onProgress?: BuildProgressListener
  ): Promise<MapRegion | null> {
    this.busy = true;
    try {
      return await this.buildNow(request, onProgress);
    } finally {
      this.busy = false;
      const next = this.queued;
      this.queued = null;
      if (next) {
        const built = this.last;
        if (
          built &&
          !shouldPrefetchRegion(
            built.spec,
            next.request.camera,
            next.request.viewport,
            this.dataZooms
          )
        ) {
          next.resolve(built);
        } else {
          this.runBuild(next.request, next.onProgress).then(next.resolve, next.reject);
        }
      }
    }
  }

  private async buildNow(
    request: RegionRequest,
    onProgress?: BuildProgressListener
  ): Promise<MapRegion | null> {
    const spec = computeRegionSpec(request.camera, request.viewport, {
      dataZooms: this.dataZooms,
    });
    const tiles = tilesCovering(spec.rect, spec.tileZoom);

    // Cold vs warm is a cache question, decided before any fetch: a swap is warm
    // (no reveal, keep the crossfade) only when every tile is already decoded.
    // A source that can't answer `has` is treated as cold.
    const total = tiles.length;
    const coldStart = this.source.has ? !tiles.every((t) => this.source.has!(t)) : true;
    let loaded = 0;
    onProgress?.({ rect: spec.rect, loaded, total, coldStart });

    const t0 = now();
    let parts: PackedGeometry[];
    try {
      parts = await Promise.all(
        tiles.map((t) =>
          this.source.getTile(t).then((part) => {
            loaded++;
            onProgress?.({ rect: spec.rect, loaded, total, coldStart });
            return part;
          })
        )
      );
    } catch (error) {
      if (this.last) return this.last;
      throw error;
    }
    const t1 = now();

    const geometry = mergeGeometry(parts);
    const t2 = now();
    const cellKey = cellFieldKey(spec, request.explorationVersion);
    let cellField = this.cellFieldCache.get(cellKey);
    const cellFieldCacheHit = cellField !== undefined;
    let cellTiming: CellFieldTiming = { enumerateMs: 0, centersMs: 0, annotateMs: 0 };
    if (cellField) {
      this.cellFieldCache.delete(cellKey);
      this.cellFieldCache.set(cellKey, cellField);
    } else {
      const built = buildCellFieldWithTiming(
        this.grid,
        spec.rect,
        spec.cellRes,
        request.exploration
      );
      cellField = built.field;
      cellTiming = built.timing;
      this.cellFieldCache.set(cellKey, cellField);
      if (this.cellFieldCache.size > CELL_FIELD_CACHE_CAPACITY) {
        const oldest = this.cellFieldCache.keys().next().value;
        if (oldest !== undefined) this.cellFieldCache.delete(oldest);
      }
    }
    const t3 = now();

    const timing: RegionTiming = {
      tiles: tiles.length,
      coldStart,
      cellFieldCacheHit,
      sourceMs: t1 - t0,
      mergeMs: t2 - t1,
      cellFieldMs: t3 - t2,
      cellEnumerateMs: cellTiming.enumerateMs,
      cellCentersMs: cellTiming.centersMs,
      cellAnnotateMs: cellTiming.annotateMs,
      totalMs: t3 - t0,
      fetchMs: t2 - t0,
      buildMs: t3 - t2,
    };

    const region: MapRegion = {
      spec,
      geometry,
      cellField,
      places: geometry.places,
      timing,
    };

    this.last = region;
    this.onTiming?.(timing);
    return region;
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function cellFieldKey(spec: RegionSpec, explorationVersion: number): string {
  const { rect } = spec;
  return `${explorationVersion}|${spec.cellRes}|${rect.minX},${rect.minY},${rect.maxX},${rect.maxY}`;
}
