import {
  applyViewTransform,
  IDENTITY_TRANSFORM,
  scaleFor,
  visibleWorldRect,
  type CameraConstraints,
  type ViewTransform,
} from '../camera';
import { applyPan, applyPinch, clampTranslation, makeViewLimits } from '../gesture';
import { computeRegionSpec } from '../region';
import { RegionSessionSim } from '../region-session';
import type { CameraState, Viewport } from '../types';

/**
 * Interaction simulation harness: scripted gestures stepped at 60 fps through
 * the PRODUCTION gesture math (core/gesture.ts) and region lifecycle
 * (core/region-session.ts), with realistic build latency. This is "what it is
 * like to use" encoded as invariants:
 *
 *   - the view is never blank (some retained region always covers it),
 *   - motion is continuous frame-to-frame (no hitches from commits/builds:
 *     commits are pure UI→JS notifications and never appear in the transform),
 *   - flings decelerate monotonically and stop,
 *   - all of it holds under pan, fling, pinch, and combinations.
 */

const FPS = 60;
const DT_MS = 1000 / FPS;
/** Reanimated withDecay's default deceleration (per ms). */
const DECAY_RATE = 0.998;
/** withDecay stops around this speed (px/s). */
const DECAY_MIN_SPEED = 5;
/** Prefetch lead, mirroring map-view: aim builds ~a latency ahead of motion. */
const PREFETCH_LEAD_FRAMES = 18;
const PREFETCH_LEAD_MAX_PX = 900;

const viewport: Viewport = { width: 390, height: 780 };
const anchor: CameraState = { center: [0.156, 0.352], zoom: 15 };
const dataZooms = { min: 0, max: 14 } as const;
const constraints: CameraConstraints = {
  // A city-scale world: ~50 viewport-widths of pan room in each direction.
  bounds: (() => {
    const s = scaleFor(anchor.zoom);
    const hw = (50 * viewport.width) / s;
    const hh = (50 * viewport.height) / s;
    return {
      minX: anchor.center[0] - hw,
      minY: anchor.center[1] - hh,
      maxX: anchor.center[0] + hw,
      maxY: anchor.center[1] + hh,
    };
  })(),
  minZoom: 12,
  maxZoom: 16,
};
const limits = makeViewLimits(anchor, viewport, constraints);

function cameraOf(t: ViewTransform): CameraState {
  return applyViewTransform(anchor, viewport, t);
}

/**
 * One simulated map session: a live transform plus the region lifecycle,
 * advanced frame by frame. `buildLatencyMs` is how long a region build takes
 * (fetch + rasterize) — the app's budget is ~300 ms warm.
 */
class MapSim {
  t: ViewTransform = IDENTITY_TRANSFORM;
  readonly session: RegionSessionSim;
  /** Screen-space movement of the content between consecutive frames (px). */
  readonly frameDeltas: number[] = [];

  constructor(buildLatencyMs: number) {
    this.session = new RegionSessionSim(
      { viewport, buildLatencySteps: Math.ceil(buildLatencyMs / DT_MS), dataZooms },
      (camera, vp) => computeRegionSpec(camera, vp, { dataZooms })
    ).warmStart(anchor);
  }

  /** Advance one frame with an optional transform mutation (a gesture step). */
  frame(mutate?: (t: ViewTransform) => ViewTransform): void {
    const before = this.t;
    if (mutate) this.t = mutate(this.t);
    // Content movement at the viewport center — the user-visible motion.
    const cx = viewport.width / 2;
    const cy = viewport.height / 2;
    const dx = this.t.k * cx + this.t.tx - (before.k * cx + before.tx);
    const dy = this.t.k * cy + this.t.ty - (before.k * cy + before.ty);
    this.frameDeltas.push(Math.hypot(dx, dy));
    // Build target led ahead of the motion, exactly like the view's reaction.
    let lx = (this.t.tx - before.tx) * PREFETCH_LEAD_FRAMES;
    let ly = (this.t.ty - before.ty) * PREFETCH_LEAD_FRAMES;
    const lead = Math.hypot(lx, ly);
    if (lead > PREFETCH_LEAD_MAX_PX) {
      lx *= PREFETCH_LEAD_MAX_PX / lead;
      ly *= PREFETCH_LEAD_MAX_PX / lead;
    }
    const leaded = clampTranslation(
      { k: this.t.k, tx: this.t.tx + lx, ty: this.t.ty + ly },
      limits
    );
    this.session.advance(cameraOf(this.t), cameraOf(leaded));
  }

  /**
   * Drag toward (vx, vy) px/s for `ms` — ramping up over the first ~200 ms the
   * way a real finger accelerates — then fling with the peak velocity.
   */
  dragAndFling(vx: number, vy: number, ms: number): void {
    const frames = Math.round(ms / DT_MS);
    const rampFrames = Math.min(frames, Math.round(200 / DT_MS));
    for (let i = 0; i < frames; i++) {
      const ramp = rampFrames > 0 ? Math.min(1, (i + 1) / rampFrames) : 1;
      this.frame((t) =>
        applyPan(t, (ramp * vx * DT_MS) / 1000, (ramp * vy * DT_MS) / 1000, limits)
      );
    }
    this.fling(vx, vy);
  }

  /** Decay from (vx, vy) px/s exactly like Reanimated's withDecay. */
  fling(vx: number, vy: number): void {
    let v = Math.hypot(vx, vy);
    const ux = v > 0 ? vx / v : 0;
    const uy = v > 0 ? vy / v : 0;
    while (v > DECAY_MIN_SPEED) {
      const step = (v * DT_MS) / 1000;
      this.frame((t) => applyPan(t, ux * step, uy * step, limits));
      v *= Math.pow(DECAY_RATE, DT_MS);
    }
  }

  /** Pinch at `factorPerFrame` around a (possibly moving) focal for `ms`. */
  pinch(factorPerFrame: number, ms: number, focal: (i: number) => [number, number]): void {
    const frames = Math.round(ms / DT_MS);
    for (let i = 0; i < frames; i++) {
      const [fx, fy] = focal(i);
      this.frame((t) => applyPinch(t, factorPerFrame, fx, fy, limits));
    }
  }

  /** Idle frames (e.g. waiting for a build to land). */
  idle(ms: number): void {
    const frames = Math.round(ms / DT_MS);
    for (let i = 0; i < frames; i++) this.frame();
  }
}

describe('interaction sim: no blank frames (warm cache, ~150 ms builds)', () => {
  it('a hard fling (2500 px/s) never reveals blank', () => {
    const sim = new MapSim(150);
    sim.dragAndFling(2200, 1200, 400);
    sim.idle(500);
    expect(sim.session.gapSteps).toBe(0);
  });

  it('continuous fast panning in changing directions stays covered without thrashing builds', () => {
    const sim = new MapSim(150);
    for (let leg = 0; leg < 6; leg++) {
      const angle = (leg * Math.PI) / 3;
      sim.dragAndFling(1400 * Math.cos(angle), 1400 * Math.sin(angle), 500);
    }
    sim.idle(500);
    expect(sim.session.gapSteps).toBe(0);
    // Six drag+fling legs (~20 s of motion) should re-region steadily, not per-frame.
    expect(sim.session.builds).toBeLessThan(45);
  });

  it('zoom-in then a diagonal fling at the new zoom stays covered', () => {
    const sim = new MapSim(150);
    sim.pinch(1.008, 1200, (i) => [200 + i, 380 - i / 2]);
    sim.idle(400);
    sim.dragAndFling(-1600, 900, 350);
    sim.idle(500);
    expect(sim.session.gapSteps).toBe(0);
  });
});

describe('interaction sim: no blank frames (cold network, 300 ms builds)', () => {
  it('a moderate fling (1400 px/s) never reveals blank', () => {
    const sim = new MapSim(300);
    sim.dragAndFling(1200, 700, 400);
    sim.idle(600);
    expect(sim.session.gapSteps).toBe(0);
  });

  it('pinching out to min zoom (view quadruples) stays covered', () => {
    const sim = new MapSim(300);
    // ~0.7%/frame out ≈ halving scale every ~1.6 s — a realistic two-finger zoom-out.
    sim.pinch(0.993, 2600, () => [200, 400]);
    sim.idle(500);
    expect(sim.session.gapSteps).toBe(0);
  });

  it('an extreme fling (2800 px/s) may briefly outrun the loader, but is bounded and recovers', () => {
    // v × latency ≈ 840 px of travel per build > the ~390 px of region headroom:
    // physically impossible to stay covered from rest with a monolithic region
    // per build (the fix beyond this envelope is per-tile progressive loading).
    // Measured exposure: one ~25-frame window (~420 ms, mostly a leading-edge
    // sliver) while the corrective build lands. The guarantee: it is a single
    // bounded window and the map is fully covered again as it glides out.
    const sim = new MapSim(300);
    sim.dragAndFling(2500, 1300, 300);
    const gapDuringFling = sim.session.gapSteps;
    expect(gapDuringFling).toBeLessThanOrEqual(26);
    sim.idle(600);
    expect(sim.session.gapSteps).toBe(gapDuringFling); // covered again, stays covered
  });

  it('slow builds (600 ms) still keep a deliberate pan covered thanks to region padding', () => {
    const sim = new MapSim(600);
    sim.dragAndFling(400, 0, 800);
    sim.idle(1200);
    expect(sim.session.gapSteps).toBe(0);
  });
});

describe('interaction sim: motion continuity (no hitches or jumps)', () => {
  it('drag → fling boundary is seamless: the first coast frame moves like the last drag frame', () => {
    const sim = new MapSim(300);
    const frames = Math.round(400 / DT_MS);
    for (let i = 0; i < frames; i++) {
      sim.frame((t) => applyPan(t, (1800 * DT_MS) / 1000, 0, limits));
    }
    const lastDragDelta = sim.frameDeltas[sim.frameDeltas.length - 1];
    sim.fling(1800, 0);
    const firstCoastDelta = sim.frameDeltas[frames];
    expect(Math.abs(firstCoastDelta - lastDragDelta)).toBeLessThan(lastDragDelta * 0.05);
  });

  it('fling deceleration is monotonic — content never speeds up or stutters on its own', () => {
    const sim = new MapSim(300);
    sim.frame(); // baseline
    const start = sim.frameDeltas.length;
    sim.fling(2400, -900);
    const coast = sim.frameDeltas.slice(start);
    for (let i = 1; i < coast.length; i++) {
      expect(coast[i]).toBeLessThanOrEqual(coast[i - 1] + 1e-9);
    }
    expect(coast[coast.length - 1]).toBeLessThan(0.2); // glides to a stop
  });

  it('builds landing mid-motion never move the content (transform is input-only)', () => {
    // The architecture makes region/commit events invisible to the transform:
    // idle frames — during which builds kick off and land inside the session —
    // must produce exactly zero content motion.
    const sim = new MapSim(120);
    sim.dragAndFling(2000, 500, 300);
    const start = sim.frameDeltas.length;
    sim.idle(1000); // builds land in here
    const idleDeltas = sim.frameDeltas.slice(start);
    expect(Math.max(...idleDeltas)).toBe(0);
  });

  it('a wandering-focal pinch never teleports: per-frame motion stays bounded by finger speed', () => {
    const sim = new MapSim(300);
    sim.pinch(1.006, 1500, (i) => [200 + 80 * Math.sin(i / 7), 400 + 60 * Math.cos(i / 11)]);
    // 0.6%/frame around a focal ≤ ~490 px from center → ≤ ~6 px/frame of drift
    // at the center probe; anything like a settle-jump would be tens of px.
    expect(Math.max(...sim.frameDeltas)).toBeLessThan(8);
  });
});

describe('interaction sim: limits hold live', () => {
  it('zoom is pinned inside [minZoom, maxZoom] every single frame of a wild session', () => {
    const sim = new MapSim(300);
    const zooms: number[] = [];
    const record = () => zooms.push(cameraOf(sim.t).zoom);
    sim.pinch(1.05, 800, () => [100, 200]);
    record();
    sim.pinch(0.93, 1500, () => [300, 700]);
    record();
    sim.dragAndFling(3000, -2000, 300);
    record();
    for (const z of zooms) {
      expect(z).toBeGreaterThanOrEqual(constraints.minZoom - 1e-9);
      expect(z).toBeLessThanOrEqual(constraints.maxZoom + 1e-9);
    }
  });

  it('a fling into the world edge stops at the edge, in bounds, and coverage recovers', () => {
    const sim = new MapSim(300);
    // Drag hard toward min-X for a long time: clamp should hold the edge.
    for (let i = 0; i < 400; i++) {
      sim.frame((t) => applyPan(t, 120, 0, limits));
    }
    const view = visibleWorldRect(cameraOf(sim.t), viewport);
    expect(view.minX).toBeGreaterThanOrEqual(constraints.bounds.minX - 1e-12);
    // 7200 px/s sustained is beyond any loader; once pinned at the edge the
    // build pipeline must catch up and stay covered.
    const gapsAtArrival = sim.session.gapSteps;
    sim.idle(800);
    expect(sim.session.gapSteps).toBe(gapsAtArrival);
  });
});
