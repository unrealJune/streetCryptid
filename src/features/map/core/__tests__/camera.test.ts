import {
  applyViewTransform,
  clampCamera,
  scaleFor,
  screenToWorld,
  viewTransformFor,
  visibleWorldRect,
  worldToScreen,
  TILE_SIZE,
} from '../camera';
import type { CameraState, Viewport, WorldPoint } from '../types';

const viewport: Viewport = { width: 390, height: 780 };
const camera: CameraState = { center: [0.1596, 0.3565], zoom: 14 };

describe('scaleFor', () => {
  it('follows the 256·2^z convention', () => {
    expect(scaleFor(0)).toBe(TILE_SIZE);
    expect(scaleFor(14)).toBe(TILE_SIZE * 2 ** 14);
  });
});

describe('worldToScreen / screenToWorld', () => {
  it('puts the camera center at the viewport center', () => {
    const [sx, sy] = worldToScreen(camera, viewport, camera.center);
    expect(sx).toBeCloseTo(viewport.width / 2, 9);
    expect(sy).toBeCloseTo(viewport.height / 2, 9);
  });

  it('are inverse of each other', () => {
    const w = screenToWorld(camera, viewport, [37, 512]);
    const [sx, sy] = worldToScreen(camera, viewport, w);
    expect(sx).toBeCloseTo(37, 6);
    expect(sy).toBeCloseTo(512, 6);
  });
});

describe('visibleWorldRect', () => {
  it('is centered on the camera with viewport/scale extents', () => {
    const rect = visibleWorldRect(camera, viewport);
    const s = scaleFor(camera.zoom);
    expect(rect.maxX - rect.minX).toBeCloseTo(viewport.width / s, 12);
    expect(rect.maxY - rect.minY).toBeCloseTo(viewport.height / s, 12);
    expect((rect.minX + rect.maxX) / 2).toBeCloseTo(camera.center[0], 12);
    expect((rect.minY + rect.maxY) / 2).toBeCloseTo(camera.center[1], 12);
  });
});

describe('clampCamera', () => {
  const constraints = {
    bounds: { minX: 0.15, minY: 0.35, maxX: 0.17, maxY: 0.37 },
    minZoom: 12,
    maxZoom: 16,
  };

  it('clamps zoom to the allowed range', () => {
    expect(clampCamera({ ...camera, zoom: 20 }, viewport, constraints).zoom).toBe(16);
    expect(clampCamera({ ...camera, zoom: 3 }, viewport, constraints).zoom).toBe(12);
  });

  it('pulls the view back inside the bounds', () => {
    const outside: CameraState = { center: [0.5, 0.5], zoom: 15 };
    const clamped = clampCamera(outside, viewport, constraints);
    const rect = visibleWorldRect(clamped, viewport);
    expect(rect.minX).toBeGreaterThanOrEqual(constraints.bounds.minX - 1e-12);
    expect(rect.maxX).toBeLessThanOrEqual(constraints.bounds.maxX + 1e-12);
    expect(rect.minY).toBeGreaterThanOrEqual(constraints.bounds.minY - 1e-12);
    expect(rect.maxY).toBeLessThanOrEqual(constraints.bounds.maxY + 1e-12);
  });

  it('centers on bounds when zoomed out past them', () => {
    const wide: CameraState = { center: [0.16, 0.36], zoom: 12 };
    const clamped = clampCamera(wide, viewport, constraints);
    // at z12 the 390px viewport spans ~4e-4 world units < bounds width 0.02? no:
    // 390 / (256·2^12) ≈ 3.7e-4 < 0.02, so the view fits; drop to a tiny bounds instead
    const tiny = {
      bounds: { minX: 0.159, minY: 0.356, maxX: 0.1591, maxY: 0.3561 },
      minZoom: 12,
      maxZoom: 16,
    };
    const c2 = clampCamera(wide, viewport, tiny);
    expect(c2.center[0]).toBeCloseTo((tiny.bounds.minX + tiny.bounds.maxX) / 2, 12);
    expect(c2.center[1]).toBeCloseTo((tiny.bounds.minY + tiny.bounds.maxY) / 2, 12);
    expect(clamped.zoom).toBe(12);
  });
});

describe('viewTransformFor / applyViewTransform (layer placement)', () => {
  const anchor: CameraState = { center: [0.15991, 0.35672], zoom: 15 };

  it('round-trips: applyViewTransform(anchor, viewTransformFor(anchor, cam)) == cam', () => {
    const cam: CameraState = { center: [0.16002, 0.35668], zoom: 15.4 };
    const t = viewTransformFor(anchor, viewport, cam);
    const back = applyViewTransform(anchor, viewport, t);
    expect(back.center[0]).toBeCloseTo(cam.center[0], 12);
    expect(back.center[1]).toBeCloseTo(cam.center[1], 12);
    expect(back.zoom).toBeCloseTo(cam.zoom, 12);
  });

  it('places a world point identically no matter which fixed anchor drew it', () => {
    // The core "no bounce" guarantee: a layer bitmap drawn in anchor space and
    // shown via viewTransformFor(anchor, cam) puts a world point at exactly
    // worldToScreen(cam, p) — independent of the anchor. So two layers with
    // different anchors overlay pixel-perfectly for the same camera.
    const cam: CameraState = { center: [0.15996, 0.3567], zoom: 15.25 };
    const p: WorldPoint = [0.16008, 0.35662];
    const truth = worldToScreen(cam, viewport, p);

    for (const a of [anchor, { center: [0.1598, 0.3569] as WorldPoint, zoom: 14 }]) {
      const t = viewTransformFor(a, viewport, cam);
      const inAnchorSpace = worldToScreen(a, viewport, p); // where the bitmap drew it
      // apply the Skia transform p' = k·p + (tx,ty)
      const sx = t.k * inAnchorSpace[0] + t.tx;
      const sy = t.k * inAnchorSpace[1] + t.ty;
      expect(sx).toBeCloseTo(truth[0], 9);
      expect(sy).toBeCloseTo(truth[1], 9);
    }
  });

  it('is identity when the camera equals the anchor', () => {
    const t = viewTransformFor(anchor, viewport, anchor);
    expect(t.k).toBeCloseTo(1, 12);
    expect(t.tx).toBeCloseTo(0, 9);
    expect(t.ty).toBeCloseTo(0, 9);
  });
});
