import { coversView, needsNewRegion, shouldPrefetchRegion, type RegionSpec } from './region';
import type { CameraState, Viewport, WorldPoint } from './types';
import { worldToScreen } from './camera';
import type { DataZoomRange } from '../tiles/tile-math';

/**
 * The map runs as a small stack of region "layers": the current one plus the
 * one it is crossfading out of. This module is the pure, testable brain of that
 * lifecycle — no React, no Skia — so the "never blank, never bounce" guarantees
 * can be asserted headlessly over simulated camera trajectories.
 */

/** What to do with the current region when the committed camera reaches `target`. */
export type RegionAction = 'reuse' | 'rebuild';

/**
 * Decide whether the current region still serves `target` or a rebuild should be
 * kicked off. Rebuild fires *ahead* of actually needing it (prefetch), so the
 * new region is usually ready before the view leaves the old one.
 */
export function regionAction(
  current: RegionSpec | null,
  target: CameraState,
  viewport: Viewport,
  dataZooms: DataZoomRange
): RegionAction {
  if (!current) return 'rebuild';
  return shouldPrefetchRegion(current, target, viewport, dataZooms) ? 'rebuild' : 'reuse';
}

/**
 * Screen position (logical px) of a world point when placed through a region's
 * bitmap. A region bitmap is drawn at its anchor's home rect and shown via
 * `viewTransformFor(anchor, camera)`; composed, that is exactly
 * `worldToScreen(camera, p)` — independent of which region's anchor placed it.
 *
 * This is the algebraic reason two overlapping layers stay pixel-aligned during
 * a crossfade (no bounce): every layer maps a given world point to the same
 * screen point for a given camera. Exposed so tests can assert it directly.
 */
export function layerScreenPoint(
  _anchorZoom: number,
  camera: CameraState,
  viewport: Viewport,
  world: WorldPoint
): readonly [number, number] {
  return worldToScreen(camera, viewport, world);
}

/** True when at least one retained region still fully covers the view (no blank). */
export function anyCovers(
  specs: readonly (RegionSpec | null)[],
  camera: CameraState,
  viewport: Viewport
): boolean {
  return specs.some((s) => s != null && coversView(s, camera, viewport));
}

export interface SessionConfig {
  readonly viewport: Viewport;
  /** How many trajectory steps a background build takes before it lands. */
  readonly buildLatencySteps: number;
  /** The tileset's data zoom range, driving rebuild decisions. */
  readonly dataZooms: DataZoomRange;
}

/**
 * A headless model of the two-layer region lifecycle, mirroring the engine's
 * one-deep build pipeline: at most one build in flight (it always runs to
 * completion and lands), at most one request waiting behind it (a newer request
 * replaces the waiting one). The current + previous regions are retained
 * exactly as the app retains its two bitmap layers, and any step where neither
 * covers the view is recorded as a gap.
 *
 * Tests drive this to prove that, for reasonable pan/zoom speeds, coverage never
 * gaps (no blank) and the retained layers always agree on placement (no bounce).
 */
export class RegionSessionSim {
  current: RegionSpec | null = null;
  prev: RegionSpec | null = null;
  /** Count of advance() steps where neither current nor prev covered the view. */
  gapSteps = 0;
  /** Count of builds kicked off — a proxy for churn. */
  builds = 0;

  private inFlight: { spec: RegionSpec; readyAt: number } | null = null;
  private queued: CameraState | null = null;
  private step = 0;

  constructor(
    private readonly config: SessionConfig,
    /** How a region spec is produced for a camera (usually `computeRegionSpec`). */
    private readonly specFor: (camera: CameraState, viewport: Viewport) => RegionSpec
  ) {}

  /** Seed the current region as if the initial load already finished (warm start). */
  warmStart(camera: CameraState): this {
    this.current = this.specFor(camera, this.config.viewport);
    return this;
  }

  /**
   * Advance one trajectory step at `camera`. `buildCamera` is what a rebuild is
   * requested FOR — the app leads it ahead of the motion (velocity/fling-rest
   * extrapolation) so a build lands about where the camera will be, not where
   * it was when the build started.
   */
  advance(camera: CameraState, buildCamera: CameraState = camera): void {
    const { viewport } = this.config;

    // A build lands after its latency: it becomes current, the old current is
    // retained as the fallback layer, and the waiting request (if any) starts.
    if (this.inFlight && this.step >= this.inFlight.readyAt) {
      this.prev = this.current;
      this.current = this.inFlight.spec;
      this.inFlight = null;
      if (this.queued) {
        this.start(this.queued);
        this.queued = null;
      }
    }

    // The rebuild check runs against the LEADED camera (like the app's
    // prefetch): "will the view still be covered a build from now?"
    if (regionAction(this.current, buildCamera, viewport, this.config.dataZooms) === 'rebuild') {
      if (this.inFlight)
        this.queued = buildCamera; // replace any waiting request
      else this.start(buildCamera);
    }

    if (!anyCovers([this.current, this.prev], camera, viewport)) this.gapSteps++;
    this.step++;
  }

  /**
   * An explicit leaded prefetch request (e.g. a fling's rest point), mirroring
   * the app's `prefetchAt`: no-op while the current region serves `camera`.
   */
  request(camera: CameraState): void {
    if (
      regionAction(this.current, camera, this.config.viewport, this.config.dataZooms) !== 'rebuild'
    )
      return;
    if (this.inFlight) this.queued = camera;
    else this.start(camera);
  }

  private start(camera: CameraState): void {
    this.inFlight = {
      spec: this.specFor(camera, this.config.viewport),
      readyAt: this.step + this.config.buildLatencySteps,
    };
    this.builds++;
  }

  /** True once the current region no longer needs an immediate rebuild for `camera`. */
  settledFor(camera: CameraState): boolean {
    return (
      this.current != null &&
      !needsNewRegion(this.current, camera, this.config.viewport, this.config.dataZooms)
    );
  }
}
