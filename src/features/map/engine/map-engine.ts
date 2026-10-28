import {
  buildCellFieldWithTimingAsync,
  type CellFieldTiming,
  type RegionCellField,
} from '../core/cell-field';
import { H3_DISPLAY_RES } from '../core/cell-ladder';
import type { ExplorationIndex } from '../core/exploration-index';
import { createExplorationRollup, type ExplorationRollup } from '../core/exploration-rollup';
import type { H3Grid } from '../core/h3-grid';
import {
  computeRegionSpec,
  PREFETCH_ZOOM_DELTA,
  shouldPrefetchRegion,
  type RegionSpec,
} from '../core/region';
import type { ElevationRaster } from '../core/terrain';
import type { CameraState, Place, Viewport, WorldPoint, WorldRect } from '../core/types';
import type { ElevationSource } from '../tiles/elevation-source';
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
  /** Monotonic within an engine, including previews; async callers can finish out of order. */
  readonly publication: number;
  readonly spec: RegionSpec;
  /**
   * Raw geometry for the region. The feature mask is now rasterized on the GPU
   * in the render layer (`buildMaskImage`) instead of on the JS thread, so the
   * region carries geometry rather than a packed pixel buffer.
   */
  readonly geometry: PackedGeometry;
  /**
   * The geometry the dot-field raster is drawn from, when it is not `geometry`
   * itself. A z14 build lands twice — the stream's `structure` stage, then the
   * full tile — and the second adds only house numbers and POIs, which are
   * labels, never pixels. Pointing it at the structure stage's geometry lets the
   * render cache recognise the raster it already has instead of drawing the
   * same bitmap again just to add names.
   */
  readonly rasterGeometry?: PackedGeometry;
  /** Fixed-resolution exploration cells, empty below their render threshold. */
  readonly cellField: RegionCellField;
  /** Named places inside the region (island headline lookup). */
  readonly places: readonly Place[];
  /**
   * Native-resolution elevation with its own rect; it may cover only the overlap
   * with the previous region while the new DEM is loading.
   * Absent (or null) draws parkland with the canopy fallback instead of terrain.
   */
  readonly elevation?: ElevationRaster | null;
  /** Exploration revision represented by the immutable cell field. */
  readonly explorationVersion: number;
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
  /** Time yielded to the UI/event loop before assembling the next region. */
  readonly yieldMs: number;
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
  /** Elevation for terrain shading. Optional: without it parks use the canopy fallback. */
  readonly elevation?: ElevationSource;
  readonly grid: H3Grid;
  /** The tileset's data zoom range. */
  readonly dataZooms: DataZoomRange;
  /** Called after each completed build. */
  readonly onTiming?: (timing: RegionTiming) => void;
}

/** One region build in flight, and everyone waiting on it. */
interface Build {
  readonly request: RegionRequest;
  readonly spec: RegionSpec;
  /** Replaced before it landed: publishes nothing more, and its callers already have null. */
  detached: boolean;
  readonly waiters: {
    resolve: (region: MapRegion | null) => void;
    reject: (error: unknown) => void;
  }[];
  readonly progressListeners: BuildProgressListener[];
  readonly previewListeners: ((region: MapRegion) => void)[];
  /** Replayed to a caller who joins mid-build, so its skeleton starts where the build is. */
  lastProgress: BuildProgress | null;
}

/**
 * Region builder with at most two live builds: the HEAD, the oldest still in
 * flight, and the TAIL, the newest request, which starts the moment it is asked
 * for rather than waiting for the head to finish.
 *
 * - A newer request replaces the tail (which resolves null and stops
 *   publishing), never the head. So continuous movement, which requests regions
 *   faster than they build, still lands the head every build interval instead
 *   of starving every build in turn.
 * - Whichever lands first wins. A tail that publishes (a preview counts)
 *   retires the head, which could only step the map backwards, and becomes the
 *   head itself.
 * - A request whose view a live build already covers joins that build.
 *
 * This replaced a one-deep pipeline whose started build always ran to the end
 * before the next one began. A build waits on every tile of its rect, and a
 * tile can wait on a cold bundle download (tens of seconds on a weak
 * connection, minutes for a z14 bundle), so one slow fetch held every later
 * pan, even into ground already cached, behind it: the map sat on one bitmap
 * while the finger moved. A retired build's downloads are never cancelled
 * (they are shared, and persisted for the next visit); the bundle source serves
 * the newest waiter first so they do not stand in front of the tail either.
 * Failures degrade to the last good region instead of blanking the map.
 */
export class MapEngine {
  private readonly source: GeometrySource;
  private readonly elevation?: ElevationSource;
  private readonly grid: H3Grid;
  private readonly dataZooms: DataZoomRange;
  private readonly onTiming?: (timing: RegionTiming) => void;

  /**
   * Coarse-rung occupancy, owned for the engine's lifetime so its per-resolution
   * ancestor sets are built once and then extended by newly explored cells only
   * — not re-derived on every region build. Assigned in the constructor, not as a
   * field initializer: those run before the constructor body sets `this.grid`.
   */
  private readonly rollup: ExplorationRollup;

  private head: Build | null = null;
  private tail: Build | null = null;
  private last: MapRegion | null = null;
  private publication = 0;
  private readonly cellFieldCache = new Map<string, RegionCellField>();

  constructor(options: MapEngineOptions) {
    this.source = options.source;
    this.elevation = options.elevation;
    this.grid = options.grid;
    this.dataZooms = options.dataZooms;
    this.onTiming = options.onTiming;
    this.rollup = createExplorationRollup(options.grid);
  }

  get lastRegion(): MapRegion | null {
    return this.last;
  }

  /**
   * Build a region for `request`. Resolves with the built region, the last good
   * region on failure, or null if a newer build replaced this one before it
   * landed; `onProgress` stops firing once it is replaced. On cold zoom-ins,
   * `onPreview` can publish a sharper raster of already-covered geometry before
   * new tiles arrive; its spec retains the actual (possibly coarser) data zoom.
   */
  buildRegion(
    request: RegionRequest,
    onProgress?: BuildProgressListener,
    onPreview?: (region: MapRegion) => void
  ): Promise<MapRegion | null> {
    const joined = this.joinable(request);
    if (joined) {
      // Back over the head's ground: wherever the tail was going, it is not here.
      if (joined === this.head && this.tail) {
        this.detach(this.tail);
        this.tail = null;
      }
      return this.attach(joined, onProgress, onPreview);
    }
    if (this.tail) this.detach(this.tail);
    const build: Build = {
      request,
      spec: computeRegionSpec(request.camera, request.viewport, { dataZooms: this.dataZooms }),
      detached: false,
      waiters: [],
      progressListeners: [],
      previewListeners: [],
      lastProgress: null,
    };
    if (this.head) this.tail = build;
    else this.head = build;
    const result = this.attach(build, onProgress, onPreview);
    this.run(build);
    return result;
  }

  /** A live build whose region already serves `request`, newest first. */
  private joinable(request: RegionRequest): Build | null {
    for (const build of [this.tail, this.head]) {
      if (
        build &&
        build.request.explorationVersion === request.explorationVersion &&
        !shouldPrefetchRegion(build.spec, request.camera, request.viewport, this.dataZooms)
      ) {
        return build;
      }
    }
    return null;
  }

  private attach(
    build: Build,
    onProgress?: BuildProgressListener,
    onPreview?: (region: MapRegion) => void
  ): Promise<MapRegion | null> {
    if (onProgress) {
      build.progressListeners.push(onProgress);
      if (build.lastProgress) onProgress(build.lastProgress);
    }
    if (onPreview) build.previewListeners.push(onPreview);
    return new Promise((resolve, reject) => build.waiters.push({ resolve, reject }));
  }

  /** Retire a build: its callers get null now, and nothing it finishes is published. */
  private detach(build: Build): void {
    build.detached = true;
    build.progressListeners.length = 0;
    build.previewListeners.length = 0;
    for (const waiter of build.waiters.splice(0)) waiter.resolve(null);
  }

  private run(build: Build): void {
    this.buildNow(build).then(
      (region) => {
        this.finish(build);
        for (const waiter of build.waiters.splice(0)) waiter.resolve(region);
      },
      (error: unknown) => {
        this.finish(build);
        for (const waiter of build.waiters.splice(0)) waiter.reject(error);
      }
    );
  }

  private finish(build: Build): void {
    if (this.head === build) {
      this.head = this.tail;
      this.tail = null;
    } else if (this.tail === build) {
      this.tail = null;
    }
  }

  private emitProgress(build: Build, progress: BuildProgress): void {
    if (build.detached) return;
    build.lastProgress = progress;
    for (const listener of build.progressListeners) listener(progress);
  }

  /**
   * Make `region` the engine's current one on behalf of `build`; null when the
   * build was replaced. A tail publishing retires the head: the head's camera is
   * older, so anything it landed afterwards would step the map backwards.
   */
  private publish(build: Build, region: MapRegion): MapRegion | null {
    if (build.detached) return null;
    if (build === this.tail && this.head) {
      this.detach(this.head);
      this.head = build;
      this.tail = null;
    }
    return this.commit(region);
  }

  /**
   * Numbered here, not when assembled: two live builds can assemble out of
   * order, and the render side keeps whichever publication is higher.
   */
  private commit(region: MapRegion): MapRegion {
    if (region === this.last) return region;
    const published = { ...region, publication: ++this.publication };
    this.last = published;
    return published;
  }

  private emitPreview(build: Build, region: MapRegion): void {
    const published = this.publish(build, region);
    if (!published) return;
    for (const listener of build.previewListeners) listener(published);
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

  private async buildNow(build: Build): Promise<MapRegion | null> {
    const { request, spec } = build;
    const wantsPreview = () => build.previewListeners.length > 0;
    const tiles = tilesCovering(spec.rect, spec.tileZoom);

    // Cold vs warm is a cache question, decided before any fetch: a swap is warm
    // (no reveal, keep the crossfade) only when every tile is already decoded.
    // A source that can't answer `has` is treated as cold.
    const total = tiles.length;
    const coldStart = this.source.has ? !tiles.every((t) => this.source.has!(t)) : true;
    let loaded = 0;
    this.emitProgress(build, { rect: spec.rect, loaded, total, coldStart });

    const previous = this.last;
    // The z14 stream opens with its own z13 overview. Geometry much coarser than
    // that, re-rasterized at street zoom, is not a preview of the street — it is
    // a wrong picture, and a full render the overview then has to wait behind.
    const streamWillPreview =
      coldStart && spec.tileZoom === 14 && wantsPreview() && !!this.source.getPreview;
    if (
      coldStart &&
      previous &&
      !(streamWillPreview && previous.spec.tileZoom < MIN_ZOOM_PREVIEW_TILE_ZOOM) &&
      spec.zoom - previous.spec.zoom >= PREFETCH_ZOOM_DELTA &&
      spec.rect.minX >= previous.spec.rect.minX &&
      spec.rect.minY >= previous.spec.rect.minY &&
      spec.rect.maxX <= previous.spec.rect.maxX &&
      spec.rect.maxY <= previous.spec.rect.maxY
    ) {
      // Re-rasterize known vectors at the NEW zoom while the larger detail
      // bundle downloads. Never pretend these are finer tiles: retaining the
      // actual data zoom lets queued requests/retries still request detail.
      const preview = await this.buildFromGeometry(
        request,
        { ...spec, tileZoom: previous.spec.tileZoom },
        previous.geometry,
        { tiles: previous.timing.tiles, coldStart: false, sourceMs: 0, mergeMs: 0 },
        // A raster carries its own rect, and the previous one covers this region:
        // keep the terrain rather than flashing the canopy fallback until relief lands.
        previous.elevation ?? null
      );
      this.emitPreview(build, preview);
    }

    const t0 = now();
    // Elevation loads beside the vectors and never fails a build: a region
    // without it draws parkland with the canopy fallback.
    const elevation: Promise<ElevationRaster | null> = this.elevation
      ? this.elevation.elevationFor(spec).catch((error: unknown) => {
          console.warn('[map] elevation unavailable:', error);
          return null;
        })
      : Promise.resolve(null);
    // Whatever relief has landed so far: a preview drawn after it arrives should
    // already be terrain, or the map redraws in a different style when detail lands.
    let elevationNow: ElevationRaster | null = null;
    void elevation.then((raster) => {
      elevationNow = raster;
    });
    // Set once full detail is in hand: a preview stage landing after it is wasted work.
    let detailLoaded = false;
    // The z14 `structure` stage, whose pixels the full tile will repeat exactly.
    let structureGeometry: PackedGeometry | null = null;
    const streamedPreview =
      coldStart && spec.tileZoom === 14 && wantsPreview() && this.source.getPreview
        ? this.source
            .getPreview(tiles, async (stage, geometry) => {
              // Stages arrive in stream order: the z13 overview, then the z14 structure part.
              if (stage.tileZoom === spec.tileZoom && stage.part === 'structure') {
                structureGeometry = geometry;
              }
              if (detailLoaded || build.detached) return;
              const preview = await this.buildFromGeometry(
                request,
                { ...spec, tileZoom: stage.tileZoom },
                geometry,
                { tiles: tiles.length, coldStart: true, sourceMs: now() - t0, mergeMs: 0 },
                elevationNow ?? previous?.elevation ?? null
              );
              if (detailLoaded) return;
              this.emitPreview(build, preview);
            })
            .catch((error: unknown) => {
              console.warn('[map] streamed preview unavailable; waiting for detail:', error);
            })
        : Promise.resolve();
    let parts: PackedGeometry[];
    try {
      parts = await Promise.all(
        tiles.map((t) =>
          this.source.getTile(t).then((part) => {
            loaded++;
            this.emitProgress(build, { rect: spec.rect, loaded, total, coldStart });
            return part;
          })
        )
      );
      detailLoaded = true;
      await streamedPreview;
    } catch (error) {
      await streamedPreview;
      if (build.detached) return null;
      if (this.last) {
        console.warn('[map] tile load failed; retaining available geometry:', error);
        return this.last;
      }
      throw error;
    }
    // Replaced while its tiles were on the wire: they are cached; the region is not wanted.
    if (build.detached) return null;
    const t1 = now();

    const geometry = mergeGeometry(parts);
    const t2 = now();
    const freshElevation = elevationNow ?? (await withDeadline(elevation, ELEVATION_GRACE_MS));
    const assembled = await this.buildFromGeometry(
      request,
      spec,
      geometry,
      {
        tiles: tiles.length,
        coldStart,
        sourceMs: t1 - t0,
        mergeMs: t2 - t1,
      },
      freshElevation ?? previous?.elevation ?? null,
      structureGeometry
    );
    const region = this.publish(build, assembled);
    if (!region) return null;
    this.onTiming?.(region.timing);
    if (!freshElevation && wantsPreview()) {
      // A retained raster is only a fallback: new relief still upgrades it after
      // the grace window, unless a newer region has replaced this one.
      void elevation.then(async (raster) => {
        if (!raster || this.last !== region) return;
        const upgraded = await this.buildFromGeometry(
          request,
          spec,
          geometry,
          region.timing,
          raster,
          region.rasterGeometry ?? null
        );
        if (this.last !== region) return;
        const published = this.commit(upgraded);
        for (const listener of build.previewListeners) listener(published);
      });
    }
    return region;
  }

  private async buildFromGeometry(
    request: RegionRequest,
    spec: RegionSpec,
    geometry: PackedGeometry,
    sourceTiming: Pick<RegionTiming, 'tiles' | 'coldStart' | 'sourceMs' | 'mergeMs'>,
    elevation: ElevationRaster | null = null,
    rasterGeometry: PackedGeometry | null = null
  ): Promise<MapRegion> {
    const queuedAt = now();
    // Cached tile promises otherwise chain region builds/renders through
    // microtasks for seconds, starving JS input and animation-frame callbacks.
    if (typeof requestAnimationFrame === 'function') {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    const t2 = now();
    const cellKey = cellFieldKey(spec, request.explorationVersion);
    let cellField = this.cellFieldCache.get(cellKey);
    const cellFieldCacheHit = cellField !== undefined;
    let cellTiming: CellFieldTiming = { enumerateMs: 0, centersMs: 0, annotateMs: 0 };
    if (cellField) {
      this.cellFieldCache.delete(cellKey);
      this.cellFieldCache.set(cellKey, cellField);
    } else {
      let built;
      if (spec.cellRes === null) {
        built = {
          field: { res: H3_DISPLAY_RES, cells: [] },
          timing: { enumerateMs: 0, centersMs: 0, annotateMs: 0 },
        };
      } else {
        try {
          built = await buildCellFieldWithTimingAsync(
            this.grid,
            spec.rect,
            spec.cellRes,
            request.exploration,
            this.rollup
          );
        } catch (error) {
          if (this.last) {
            console.warn('[map] cell field failed; retaining available region:', error);
            return this.last;
          }
          throw error;
        }
      }
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
      ...sourceTiming,
      yieldMs: t2 - queuedAt,
      cellFieldCacheHit,
      cellFieldMs: t3 - t2,
      cellEnumerateMs: cellTiming.enumerateMs,
      cellCentersMs: cellTiming.centersMs,
      cellAnnotateMs: cellTiming.annotateMs,
      totalMs: sourceTiming.sourceMs + sourceTiming.mergeMs + t3 - queuedAt,
      fetchMs: sourceTiming.sourceMs + sourceTiming.mergeMs,
      buildMs: t3 - t2,
    };

    const region: MapRegion = {
      publication: 0, // numbered by `commit` when published
      spec,
      geometry,
      ...(rasterGeometry ? { rasterGeometry } : {}),
      cellField,
      places: geometry.places,
      elevation,
      explorationVersion: request.explorationVersion,
      timing,
    };

    return region;
  }
}

/**
 * Coarsest data a zoom-in preview may re-rasterize when a streamed z13 overview
 * is coming anyway (see `buildNow`).
 */
const MIN_ZOOM_PREVIEW_TILE_ZOOM = 12;

/**
 * How long a finished vector build waits for elevation that is still loading.
 * Elevation only shades parkland, so it must never hold a map hostage: past this
 * the region lands with the canopy fallback and is upgraded when relief arrives.
 */
const ELEVATION_GRACE_MS = 300;

function withDeadline<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function cellFieldKey(spec: RegionSpec, explorationVersion: number): string {
  const { rect } = spec;
  return `${explorationVersion}|${spec.cellRes}|${rect.minX},${rect.minY},${rect.maxX},${rect.maxY}`;
}
