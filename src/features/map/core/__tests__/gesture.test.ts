import {
  applyViewTransform,
  IDENTITY_TRANSFORM,
  screenToWorld,
  visibleWorldRect,
  worldToScreen,
  type CameraConstraints,
  type ViewTransform,
} from '../camera';
import {
  applyPan,
  applyPinch,
  clampPinchFactor,
  clampTranslation,
  makeViewLimits,
  transformDistanceSq,
  translationRange,
} from '../gesture';
import type { CameraState, Viewport, WorldPoint } from '../types';

const viewport: Viewport = { width: 400, height: 800 };
const anchor: CameraState = { center: [0.156, 0.352], zoom: 15 };

/** Generous bounds so mid-world gestures never hit the clamp. */
const openConstraints: CameraConstraints = {
  bounds: { minX: 0.1, minY: 0.3, maxX: 0.2, maxY: 0.4 },
  minZoom: 12,
  maxZoom: 16,
};
const openLimits = makeViewLimits(anchor, viewport, openConstraints);

/** The camera a transform renders — for cross-checking against camera math. */
function cameraOf(t: ViewTransform): CameraState {
  return applyViewTransform(anchor, viewport, t);
}

describe('makeViewLimits', () => {
  it('maps the zoom range to composed-scale range around the anchor zoom', () => {
    expect(openLimits.kMin).toBeCloseTo(Math.pow(2, 12 - 15), 12);
    expect(openLimits.kMax).toBeCloseTo(Math.pow(2, 16 - 15), 12);
  });

  it('places the bounds rect where worldToScreen puts it at the anchor', () => {
    const [x, y] = worldToScreen(anchor, viewport, [0.1, 0.3]);
    expect(openLimits.boundsX).toBeCloseTo(x, 9);
    expect(openLimits.boundsY).toBeCloseTo(y, 9);
  });
});

describe('applyPan', () => {
  it('moves the world content exactly with the finger', () => {
    const t = applyPan(IDENTITY_TRANSFORM, 37, -12, openLimits);
    // A world point's screen position moves by exactly (dx, dy).
    const p: WorldPoint = anchor.center;
    const before = worldToScreen(cameraOf(IDENTITY_TRANSFORM), viewport, p);
    const after = worldToScreen(cameraOf(t), viewport, p);
    expect(after[0] - before[0]).toBeCloseTo(37, 9);
    expect(after[1] - before[1]).toBeCloseTo(-12, 9);
  });

  it('accumulates a long drag without drift', () => {
    let t: ViewTransform = IDENTITY_TRANSFORM;
    for (let i = 0; i < 600; i++) t = applyPan(t, 0.7, -0.3, openLimits);
    expect(t.tx).toBeCloseTo(600 * 0.7, 6);
    expect(t.ty).toBeCloseTo(600 * -0.3, 6);
    expect(t.k).toBe(1);
  });
});

describe('applyPinch', () => {
  it('keeps the world point under the focal fixed (anchor invariance)', () => {
    const focal: [number, number] = [123, 456];
    const t0 = applyPan(IDENTITY_TRANSFORM, 40, 25, openLimits);
    const anchorWorld = screenToWorld(cameraOf(t0), viewport, focal);

    const t1 = applyPinch(t0, 1.3, focal[0], focal[1], openLimits);
    const after = worldToScreen(cameraOf(t1), viewport, anchorWorld);
    expect(after[0]).toBeCloseTo(focal[0], 6);
    expect(after[1]).toBeCloseTo(focal[1], 6);
  });

  it('is exact across many small steps with a MOVING focal', () => {
    // Simulate a real pinch: 120 events, focal wandering, scale creeping up.
    // At every single step the point under the instantaneous focal must not move.
    let t: ViewTransform = IDENTITY_TRANSFORM;
    for (let i = 0; i < 120; i++) {
      const fx = 200 + 60 * Math.sin(i / 9);
      const fy = 400 + 80 * Math.cos(i / 13);
      const c = 1 + 0.004 * Math.sin(i / 5) + 0.003;
      const anchorWorld = screenToWorld(cameraOf(t), viewport, [fx, fy]);
      t = applyPinch(t, c, fx, fy, openLimits);
      const after = worldToScreen(cameraOf(t), viewport, anchorWorld);
      expect(after[0]).toBeCloseTo(fx, 5);
      expect(after[1]).toBeCloseTo(fy, 5);
    }
  });

  it('zoom never exceeds the configured range, and the focal stays honest at the limit', () => {
    let t: ViewTransform = IDENTITY_TRANSFORM;
    const focal: [number, number] = [200, 400];
    for (let i = 0; i < 60; i++) t = applyPinch(t, 1.2, focal[0], focal[1], openLimits);
    expect(cameraOf(t).zoom).toBeCloseTo(16, 9);

    // Once pinned at max zoom, further pinching must not slide the content.
    const pinned = applyPinch(t, 1.5, focal[0], focal[1], openLimits);
    expect(pinned).toEqual(t);

    for (let i = 0; i < 90; i++) t = applyPinch(t, 0.8, focal[0], focal[1], openLimits);
    expect(cameraOf(t).zoom).toBeGreaterThanOrEqual(12 - 1e-9);
  });
});

describe('clampPinchFactor', () => {
  it('passes factors through inside the range and clips at the edges', () => {
    expect(clampPinchFactor(1.1, 1, openLimits)).toBe(1.1);
    expect(clampPinchFactor(4, 1, openLimits)).toBeCloseTo(openLimits.kMax, 12);
    expect(clampPinchFactor(0.01, 1, openLimits)).toBeCloseTo(openLimits.kMin, 12);
  });
});

describe('bounds clamping', () => {
  // Tight bounds: exactly one viewport at the anchor zoom, so any pan clamps.
  const tight: CameraConstraints = {
    bounds: visibleWorldRect(anchor, viewport),
    minZoom: 12,
    maxZoom: 16,
  };
  const tightLimits = makeViewLimits(anchor, viewport, tight);

  it('view never leaves the bounds under any pan', () => {
    let t: ViewTransform = IDENTITY_TRANSFORM;
    for (let i = 0; i < 50; i++) t = applyPan(t, 60, 45, tightLimits);
    const view = visibleWorldRect(cameraOf(t), viewport);
    expect(view.minX).toBeGreaterThanOrEqual(tight.bounds.minX - 1e-12);
    expect(view.minY).toBeGreaterThanOrEqual(tight.bounds.minY - 1e-12);
  });

  it('centers the axis when zoomed out past the bounds size', () => {
    // Zoom way out: bounds smaller than view on both axes → centered.
    let t: ViewTransform = IDENTITY_TRANSFORM;
    for (let i = 0; i < 40; i++) t = applyPinch(t, 0.8, 200, 400, tightLimits);
    const cam = cameraOf(t);
    expect(cam.center[0]).toBeCloseTo(anchor.center[0], 9);
    expect(cam.center[1]).toBeCloseTo(anchor.center[1], 9);
  });

  it('translationRange collapses to a single centering value when bounds fit inside the view', () => {
    const [lo, hi] = translationRange(0.25, tightLimits.boundsX, tightLimits.boundsW, 400);
    expect(lo).toBe(hi);
  });

  it('clampTranslation returns the same object when already inside (no UI-thread churn)', () => {
    const t: ViewTransform = { k: 1, tx: 0, ty: 0 };
    expect(clampTranslation(t, tightLimits)).toBe(t);
  });

  it('zooming in at a corner then out again stays within bounds throughout', () => {
    let t: ViewTransform = IDENTITY_TRANSFORM;
    for (let i = 0; i < 20; i++) t = applyPinch(t, 1.15, 10, 10, tightLimits);
    for (let i = 0; i < 40; i++) {
      t = applyPinch(t, 0.9, 390, 790, tightLimits);
      const view = visibleWorldRect(cameraOf(t), viewport);
      const bw = tight.bounds.maxX - tight.bounds.minX;
      const vw = view.maxX - view.minX;
      if (vw <= bw + 1e-12) {
        expect(view.minX).toBeGreaterThanOrEqual(tight.bounds.minX - 1e-9);
        expect(view.maxX).toBeLessThanOrEqual(tight.bounds.maxX + 1e-9);
      }
    }
  });
});

describe('transformDistanceSq', () => {
  it('is zero for identical transforms and grows with pan distance', () => {
    const a: ViewTransform = { k: 1, tx: 10, ty: 20 };
    expect(transformDistanceSq(a, a)).toBe(0);
    expect(transformDistanceSq({ k: 1, tx: 100, ty: 20 }, a)).toBeCloseTo(8100, 9);
  });

  it('treats ~15% scale change like ~90 px of pan', () => {
    const a: ViewTransform = { k: 1, tx: 0, ty: 0 };
    const b: ViewTransform = { k: 1.15, tx: 0, ty: 0 };
    expect(Math.sqrt(transformDistanceSq(b, a))).toBeCloseTo(90, 0);
  });
});
