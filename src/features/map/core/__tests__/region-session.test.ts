import { scaleFor, worldToScreen } from '../camera';
import { anyCovers, layerScreenPoint, regionAction, RegionSessionSim } from '../region-session';
import { computeRegionSpec, coversView } from '../region';
import { resForZoom } from '../cell-ladder';
import type { CameraState, Viewport, WorldPoint } from '../types';

const viewport: Viewport = { width: 800, height: 1700 };
const home: WorldPoint = [0.1596, 0.3565];
const legacyZooms = { min: 12, max: 14 };
const specFor = (camera: CameraState, vp: Viewport) =>
  computeRegionSpec(camera, vp, { dataZooms: legacyZooms });

/** Pan `views` viewport-widths east over `steps` frames at zoom 15. */
function panTrajectory(views: number, steps: number, zoom = 15): CameraState[] {
  const worldPerView = viewport.width / scaleFor(zoom);
  return Array.from({ length: steps + 1 }, (_, i) => ({
    center: [home[0] + (views * worldPerView * i) / steps, home[1]] as WorldPoint,
    zoom,
  }));
}

/** Zoom from `z0` to `z1` over `steps` frames, centered on home. */
function zoomTrajectory(z0: number, z1: number, steps: number): CameraState[] {
  return Array.from({ length: steps + 1 }, (_, i) => ({
    center: home,
    zoom: z0 + ((z1 - z0) * i) / steps,
  }));
}

function run(trajectory: CameraState[], buildLatencySteps: number): RegionSessionSim {
  const sim = new RegionSessionSim(
    { viewport, buildLatencySteps, dataZooms: legacyZooms },
    specFor
  );
  sim.warmStart(trajectory[0]); // initial load finished before the user interacts
  for (const camera of trajectory) sim.advance(camera);
  return sim;
}

describe('regionAction', () => {
  it('rebuilds when there is no region yet', () => {
    expect(regionAction(null, { center: home, zoom: 15 }, viewport, legacyZooms)).toBe('rebuild');
  });

  it('reuses a fresh region at its build camera', () => {
    const spec = specFor({ center: home, zoom: 15 }, viewport);
    expect(regionAction(spec, { center: home, zoom: 15 }, viewport, legacyZooms)).toBe('reuse');
  });

  it('rebuilds (prefetch) as the view nears the region edge', () => {
    const spec = specFor({ center: home, zoom: 15 }, viewport);
    const worldPerView = viewport.width / scaleFor(15);
    // pad = 1.0 view of headroom; margin 0.35 → prefetch past ~0.65 views.
    const nearEdge: CameraState = { center: [home[0] + worldPerView * 0.75, home[1]], zoom: 15 };
    expect(regionAction(spec, nearEdge, viewport, legacyZooms)).toBe('rebuild');
  });
});

describe('layer placement continuity (no bounce)', () => {
  it('maps a world point to the same screen point regardless of the layer anchor', () => {
    const camera: CameraState = { center: [home[0] + 1e-4, home[1] - 5e-5], zoom: 15.3 };
    const p: WorldPoint = [home[0] + 3e-4, home[1] + 2e-4];
    // Two different region anchors (e.g. current vs previous layer during a fade).
    const viaCurrent = layerScreenPoint(15, camera, viewport, p);
    const viaPrev = layerScreenPoint(14, camera, viewport, p);
    const truth = worldToScreen(camera, viewport, p);
    expect(viaCurrent[0]).toBeCloseTo(truth[0], 6);
    expect(viaCurrent[1]).toBeCloseTo(truth[1], 6);
    // Overlapping layers agree exactly → pixel-aligned crossfade, no bounce.
    expect(viaPrev[0]).toBeCloseTo(viaCurrent[0], 6);
    expect(viaPrev[1]).toBeCloseTo(viaCurrent[1], 6);
  });
});

describe('coverage over a pan (no blank)', () => {
  it('never gaps for a slow pan even with a fresh (cold) start', () => {
    // 3 viewport-widths over 120 steps ≈ 0.025 view/step (a deliberate pan).
    const sim = run(panTrajectory(3, 120), /* latency */ 4);
    expect(sim.gapSteps).toBe(0);
    expect(sim.builds).toBeGreaterThan(1); // it did cross regions
  });

  it('never gaps for a brisk pan with a realistic build latency', () => {
    // 3 views over 60 steps ≈ 0.05 view/step; build takes 6 steps.
    const sim = run(panTrajectory(3, 60), 6);
    expect(sim.gapSteps).toBe(0);
  });

  it('keeps the previous layer covering while a rebuild is in flight', () => {
    // Brisk pan (0.033 view/step) with a realistic build latency (4 steps): the
    // prefetch lead exceeds the latency, so prev+current always jointly cover.
    const sim = new RegionSessionSim(
      { viewport, buildLatencySteps: 4, dataZooms: legacyZooms },
      specFor
    );
    const traj = panTrajectory(2, 60);
    sim.warmStart(traj[0]);
    let sawPending = false;
    for (const camera of traj) {
      sim.advance(camera);
      if (sim.prev && sim.current && sim.prev !== sim.current) {
        sawPending = true;
        expect(anyCovers([sim.current, sim.prev], camera, viewport)).toBe(true);
      }
    }
    expect(sawPending).toBe(true);
    expect(sim.gapSteps).toBe(0);
  });

  it('never gaps on a long continuous drag (mid-gesture prefetch, no settle)', () => {
    // 6 viewport-widths in one uninterrupted drag: each live-camera step may
    // prefetch (build for the live camera without committing) — the app path.
    const sim = run(panTrajectory(6, 200), 6);
    expect(sim.gapSteps).toBe(0);
    expect(sim.builds).toBeGreaterThan(3); // it recentered several times mid-drag
  });
});

describe('coverage over a zoom (no blank)', () => {
  it('never gaps zooming in across data bands', () => {
    const sim = run(zoomTrajectory(13, 16, 90), 5);
    expect(sim.gapSteps).toBe(0);
  });

  it('never gaps zooming out across data bands', () => {
    const sim = run(zoomTrajectory(16, 12.5, 90), 5);
    expect(sim.gapSteps).toBe(0);
  });
});

describe('sim fidelity (the model can actually gap)', () => {
  it('a teleport beyond all padding before any build lands does gap', () => {
    const sim = new RegionSessionSim(
      { viewport, buildLatencySteps: 5, dataZooms: legacyZooms },
      specFor
    );
    sim.advance({ center: home, zoom: 15 }); // builds region A (lands after 5 steps)
    const worldPerView = viewport.width / scaleFor(15);
    // Jump 5 viewports away instantly — nothing built there yet.
    sim.advance({ center: [home[0] + worldPerView * 5, home[1]], zoom: 15 });
    expect(sim.gapSteps).toBeGreaterThan(0);
  });

  it('settledFor is true once a region is built for the camera', () => {
    const sim = new RegionSessionSim(
      { viewport, buildLatencySteps: 0, dataZooms: legacyZooms },
      specFor
    );
    const camera: CameraState = { center: home, zoom: 15 };
    sim.warmStart(camera);
    expect(sim.settledFor(camera)).toBe(true);
  });
});

describe('global zoom-out (planet range + ladder)', () => {
  const planet = { min: 0, max: 14 };
  const planetSpecFor = (camera: CameraState, vp: Viewport) =>
    computeRegionSpec(camera, vp, { dataZooms: planet });

  it('never gaps on a continuous z15 → z1 zoom-out to the globe', () => {
    const sim = new RegionSessionSim(
      { viewport, buildLatencySteps: 5, dataZooms: planet },
      planetSpecFor
    );
    const traj = zoomTrajectory(15, 1, 420);
    sim.warmStart(traj[0]);
    for (const camera of traj) sim.advance(camera);
    expect(sim.gapSteps).toBe(0);
    // Crosses 14 zoom levels; the prefetch cadence is one rebuild per ~0.45
    // zoom of drift (~31) plus rung/data-zoom rebuilds — bounded well below
    // one per step, which is what would signal churn.
    expect(sim.builds).toBeGreaterThan(14);
    expect(sim.builds).toBeLessThan(80);
  });

  it('keeps every region build within a sane cell budget across the descent', () => {
    for (let z = 15; z >= 1; z -= 0.5) {
      const spec = planetSpecFor({ center: home, zoom: z }, viewport);
      // The ladder holds the rect-to-res pairing monotone — the direct
      // cell-count budget is asserted in map-engine tests against real
      // enumeration.
      expect(spec.cellRes).toBe(resForZoom(z));
      expect(spec.tileZoom).toBeLessThanOrEqual(14);
    }
  });
});

describe('anyCovers', () => {
  it('is false when no region is retained', () => {
    expect(anyCovers([null, null], { center: home, zoom: 15 }, viewport)).toBe(false);
  });

  it('is true when a retained region covers the view', () => {
    const spec = specFor({ center: home, zoom: 15 }, viewport);
    expect(anyCovers([null, spec], { center: home, zoom: 15 }, viewport)).toBe(true);
    expect(coversView(spec, { center: home, zoom: 15 }, viewport)).toBe(true);
  });
});
