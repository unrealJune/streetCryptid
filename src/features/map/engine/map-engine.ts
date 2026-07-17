import { buildCellField, type RegionCellField } from '../core/cell-field';
import type { ExplorationIndex } from '../core/exploration-index';
import type { H3Grid } from '../core/h3-grid';
import { computeRegionSpec, type RegionSpec } from '../core/region';
import type { CameraState, MapGeometry, Place, Viewport } from '../core/types';
import type { GeometrySource } from '../tiles/geometry-source';
import { mergeGeometry } from '../tiles/geometry-source';
import { tilesCovering, type DataZoomRange } from '../tiles/tile-math';

/** Everything a region build depends on besides the engine's own wiring. */
export interface RegionRequest {
  readonly camera: CameraState;
  readonly viewport: Viewport;
  readonly exploration: ExplorationIndex;
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
  readonly geometry: MapGeometry;
  /** Exploration cells at the region's ladder rung, annotated for rendering. */
  readonly cellField: RegionCellField;
  /** Named places inside the region (island headline lookup). */
  readonly places: readonly Place[];
}

/** Per-build timing breakdown, for dev logging / perf tracking. */
export interface RegionTiming {
  readonly tiles: number;
  readonly fetchMs: number;
  readonly buildMs: number;
}

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
    resolve: (region: MapRegion | null) => void;
    reject: (error: unknown) => void;
  } | null = null;
  private last: MapRegion | null = null;

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
   * one while it waited in the queue.
   */
  buildRegion(request: RegionRequest): Promise<MapRegion | null> {
    if (this.busy) {
      this.queued?.resolve(null); // superseded while waiting
      return new Promise((resolve, reject) => {
        this.queued = { request, resolve, reject };
      });
    }
    return this.runBuild(request);
  }

  private async runBuild(request: RegionRequest): Promise<MapRegion | null> {
    this.busy = true;
    try {
      return await this.buildNow(request);
    } finally {
      this.busy = false;
      const next = this.queued;
      this.queued = null;
      if (next) this.runBuild(next.request).then(next.resolve, next.reject);
    }
  }

  private async buildNow(request: RegionRequest): Promise<MapRegion | null> {
    const spec = computeRegionSpec(request.camera, request.viewport, {
      dataZooms: this.dataZooms,
    });
    const tiles = tilesCovering(spec.rect, spec.tileZoom);

    const t0 = now();
    let geometry;
    try {
      const parts = await Promise.all(tiles.map((t) => this.source.getTile(t)));
      geometry = mergeGeometry(parts);
    } catch (error) {
      if (this.last) return this.last;
      throw error;
    }
    const t1 = now();

    const cellField = buildCellField(this.grid, spec.rect, spec.cellRes, request.exploration);

    const region: MapRegion = {
      spec,
      geometry,
      cellField,
      places: geometry.places,
    };

    this.last = region;
    this.onTiming?.({ tiles: tiles.length, fetchMs: t1 - t0, buildMs: now() - t1 });
    return region;
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
