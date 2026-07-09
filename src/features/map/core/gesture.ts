import type { CameraConstraints, ViewTransform } from './camera';
import { scaleFor, worldToScreen } from './camera';
import type { CameraState, Viewport } from './types';

/**
 * Pure gesture math for the map's single live view transform.
 *
 * The whole visual state of the map is ONE anchor-space transform
 * p′ = k·p + (tx, ty), owned by the UI thread (Reanimated shared values).
 * Gestures compose into it exactly, event by event:
 *   - pan by (dx, dy):              t += Δ
 *   - pinch by c around focal f:    k′ = c·k,  t′ = c·t + (1 − c)·f
 * React never writes it back mid-session (only on viewport resize), so a
 * region build landing — or any other async work — can never move the view.
 * That invariant is what kills the settle/reset jumps.
 *
 * Every function here is a worklet (runs on the UI thread) and pure (plain
 * data in/out), so the exact production math is unit-testable in Node.
 */

/** Zoom + pan limits, precomputed into anchor-space pixels for worklet use. */
export interface ViewLimits {
  /** Composed-scale range: k ∈ [kMin, kMax] ⇔ zoom ∈ [minZoom, maxZoom]. */
  readonly kMin: number;
  readonly kMax: number;
  /** World bounds as an anchor-space pixel rect. */
  readonly boundsX: number;
  readonly boundsY: number;
  readonly boundsW: number;
  readonly boundsH: number;
  readonly viewW: number;
  readonly viewH: number;
}

/** Precompute {@link ViewLimits} (JS side, once per anchor/viewport/dataset). */
export function makeViewLimits(
  anchor: CameraState,
  viewport: Viewport,
  constraints: CameraConstraints
): ViewLimits {
  const { bounds, minZoom, maxZoom } = constraints;
  const [x0, y0] = worldToScreen(anchor, viewport, [bounds.minX, bounds.minY]);
  const s = scaleFor(anchor.zoom);
  return {
    kMin: Math.pow(2, minZoom - anchor.zoom),
    kMax: Math.pow(2, maxZoom - anchor.zoom),
    boundsX: x0,
    boundsY: y0,
    boundsW: (bounds.maxX - bounds.minX) * s,
    boundsH: (bounds.maxY - bounds.minY) * s,
    viewW: viewport.width,
    viewH: viewport.height,
  };
}

/**
 * Allowed translation range on one axis at composed scale `k`: the viewport
 * must stay inside the (scaled) bounds. When the bounds are narrower than the
 * viewport, both ends collapse to the centering translation.
 */
export function translationRange(
  k: number,
  boundsMin: number,
  boundsSize: number,
  viewSize: number
): readonly [number, number] {
  'worklet';
  const lo = viewSize - k * (boundsMin + boundsSize);
  const hi = -k * boundsMin;
  if (lo > hi) {
    const center = (lo + hi) / 2;
    return [center, center];
  }
  return [lo, hi];
}

/** Clamp a transform's translation so the view stays inside the bounds. */
export function clampTranslation(t: ViewTransform, limits: ViewLimits): ViewTransform {
  'worklet';
  const [txLo, txHi] = translationRange(t.k, limits.boundsX, limits.boundsW, limits.viewW);
  const [tyLo, tyHi] = translationRange(t.k, limits.boundsY, limits.boundsH, limits.viewH);
  const tx = t.tx < txLo ? txLo : t.tx > txHi ? txHi : t.tx;
  const ty = t.ty < tyLo ? tyLo : t.ty > tyHi ? tyHi : t.ty;
  return tx === t.tx && ty === t.ty ? t : { k: t.k, tx, ty };
}

/**
 * Clamp an incremental pinch factor so the composed scale stays in range.
 * Clamping the FACTOR (before composing) keeps the focal math exact — the
 * world point under the finger never slides, even while pinned at a limit.
 */
export function clampPinchFactor(c: number, k: number, limits: ViewLimits): number {
  'worklet';
  const lo = limits.kMin / k;
  const hi = limits.kMax / k;
  return c < lo ? lo : c > hi ? hi : c;
}

/** Compose a pan step into the transform, clamped to bounds. */
export function applyPan(
  t: ViewTransform,
  dx: number,
  dy: number,
  limits: ViewLimits
): ViewTransform {
  'worklet';
  return clampTranslation({ k: t.k, tx: t.tx + dx, ty: t.ty + dy }, limits);
}

/**
 * Compose an incremental pinch (factor `c` around screen focal `(fx, fy)`)
 * into the transform, clamped to the zoom range and bounds. Exact for a
 * moving focal: each event scales around the CURRENT focal, which composes
 * to precisely the transform the fingers described.
 */
export function applyPinch(
  t: ViewTransform,
  c: number,
  fx: number,
  fy: number,
  limits: ViewLimits
): ViewTransform {
  'worklet';
  const cc = clampPinchFactor(c, t.k, limits);
  return clampTranslation(
    {
      k: cc * t.k,
      tx: cc * t.tx + (1 - cc) * fx,
      ty: cc * t.ty + (1 - cc) * fy,
    },
    limits
  );
}

/**
 * Squared "view distance" between two transforms in screen px — how far apart
 * two frames would look. Used to throttle prefetch (movement gate), not for
 * anything precision-critical.
 */
export function transformDistanceSq(a: ViewTransform, b: ViewTransform): number {
  'worklet';
  const dk = (a.k / b.k - 1) * 600; // ~15% scale change ≈ 90 px pan
  const dx = a.tx - b.tx;
  const dy = a.ty - b.ty;
  return dx * dx + dy * dy + dk * dk;
}
