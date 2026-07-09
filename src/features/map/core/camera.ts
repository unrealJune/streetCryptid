import type { CameraState, ScreenPoint, Viewport, WorldPoint, WorldRect } from './types';

import { clamp } from './color';

/** Standard web-map convention: the world is TILE_SIZE·2^zoom logical px wide. */
export const TILE_SIZE = 256;

/** Logical pixels per world unit at a zoom level. */
export function scaleFor(zoom: number): number {
  return TILE_SIZE * Math.pow(2, zoom);
}

/** Camera movement limits: where the camera may look and how far it may zoom. */
export interface CameraConstraints {
  readonly bounds: WorldRect;
  readonly minZoom: number;
  readonly maxZoom: number;
}

export function worldToScreen(
  camera: CameraState,
  viewport: Viewport,
  [wx, wy]: WorldPoint
): ScreenPoint {
  const s = scaleFor(camera.zoom);
  return [
    (wx - camera.center[0]) * s + viewport.width / 2,
    (wy - camera.center[1]) * s + viewport.height / 2,
  ];
}

export function screenToWorld(
  camera: CameraState,
  viewport: Viewport,
  [sx, sy]: ScreenPoint
): WorldPoint {
  const s = scaleFor(camera.zoom);
  return [
    camera.center[0] + (sx - viewport.width / 2) / s,
    camera.center[1] + (sy - viewport.height / 2) / s,
  ];
}

/** The world rectangle currently visible through the viewport. */
export function visibleWorldRect(camera: CameraState, viewport: Viewport): WorldRect {
  const s = scaleFor(camera.zoom);
  const halfW = viewport.width / 2 / s;
  const halfH = viewport.height / 2 / s;
  return {
    minX: camera.center[0] - halfW,
    minY: camera.center[1] - halfH,
    maxX: camera.center[0] + halfW,
    maxY: camera.center[1] + halfH,
  };
}

/**
 * An accumulated screen-space view transform: p′ = k·p + (tx, ty). Gestures
 * compose into it exactly (pan: t += Δ; pinch by c at focal f: k′ = c·k,
 * t′ = c·t + (1−c)·f), so any sequence of pans and pinches — including
 * multiple pinches at different focals — stays exact. Identity: {k:1,tx:0,ty:0}.
 */
export interface ViewTransform {
  readonly k: number;
  readonly tx: number;
  readonly ty: number;
}

export const IDENTITY_TRANSFORM: ViewTransform = { k: 1, tx: 0, ty: 0 };

/** The camera that renders identically to `base` seen through transform `t`. */
export function applyViewTransform(
  base: CameraState,
  viewport: Viewport,
  t: ViewTransform
): CameraState {
  const s0 = scaleFor(base.zoom);
  const s = s0 * t.k;
  return {
    center: [
      base.center[0] + (((1 - t.k) * viewport.width) / 2 - t.tx) / s,
      base.center[1] + (((1 - t.k) * viewport.height) / 2 - t.ty) / s,
    ],
    zoom: base.zoom + Math.log2(t.k),
  };
}

/** Inverse of {@link applyViewTransform}: the transform that shows `camera` over `base`. */
export function viewTransformFor(
  base: CameraState,
  viewport: Viewport,
  camera: CameraState
): ViewTransform {
  const k = Math.pow(2, camera.zoom - base.zoom);
  const s = scaleFor(base.zoom) * k;
  return {
    k,
    tx: ((1 - k) * viewport.width) / 2 - (camera.center[0] - base.center[0]) * s,
    ty: ((1 - k) * viewport.height) / 2 - (camera.center[1] - base.center[1]) * s,
  };
}

/**
 * Clamp zoom to range and the visible rect inside `bounds`. If the view is wider
 * than the bounds on an axis, the camera centers on the bounds instead.
 */
export function clampCamera(
  camera: CameraState,
  viewport: Viewport,
  constraints: CameraConstraints
): CameraState {
  const zoom = clamp(camera.zoom, constraints.minZoom, constraints.maxZoom);
  const s = scaleFor(zoom);
  const halfW = viewport.width / 2 / s;
  const halfH = viewport.height / 2 / s;
  const b = constraints.bounds;

  const cx =
    2 * halfW >= b.maxX - b.minX
      ? (b.minX + b.maxX) / 2
      : clamp(camera.center[0], b.minX + halfW, b.maxX - halfW);
  const cy =
    2 * halfH >= b.maxY - b.minY
      ? (b.minY + b.maxY) / 2
      : clamp(camera.center[1], b.minY + halfH, b.maxY - halfH);

  return { center: [cx, cy], zoom };
}
