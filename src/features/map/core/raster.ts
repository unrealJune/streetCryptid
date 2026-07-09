import type { Mask, ScreenPoint, Viewport } from './types';

/**
 * A mask being drawn into. Same shape as {@link Mask} but mutable by contract;
 * finished masks are passed on as the readonly type.
 */
export interface MutableMask {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/**
 * Rasterizes vector features into 8-bit coverage masks — the one bitmap-producing
 * step of the pipeline. Kept behind an interface so the pure software
 * implementation below could be swapped for a GPU/Skia-backed one without
 * touching any caller.
 */
export interface MaskRasterizer {
  createMask(size: Viewport): MutableMask;
  /** Stamp a round-capped stroked polyline; blends with max() like the mock's overdraw. */
  strokePolyline(
    mask: MutableMask,
    points: readonly ScreenPoint[],
    width: number,
    value: number
  ): void;
  /** Fill a polygon (outer rings + holes) by the even-odd rule; max() blend. */
  fillPolygonEvenOdd(
    mask: MutableMask,
    rings: readonly (readonly ScreenPoint[])[],
    value: number
  ): void;
}

export const softwareRasterizer: MaskRasterizer = {
  createMask({ width, height }: Viewport): MutableMask {
    return {
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
      data: new Uint8Array(Math.max(1, Math.round(width)) * Math.max(1, Math.round(height))),
    };
  },

  strokePolyline(mask, points, width, value) {
    const half = width / 2;
    for (let i = 0; i < points.length - 1; i++) {
      stampSegment(mask, points[i], points[i + 1], half, value);
    }
    if (points.length === 1) stampSegment(mask, points[0], points[0], half, value);
  },

  fillPolygonEvenOdd(mask, rings, value) {
    if (!rings.length) return;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const ring of rings) {
      for (const [, y] of ring) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(mask.height - 1, Math.ceil(maxY));
    const xs: number[] = [];

    for (let py = y0; py <= y1; py++) {
      const scanY = py + 0.5;
      xs.length = 0;
      for (const ring of rings) {
        for (let i = 0; i < ring.length; i++) {
          const [ax, ay] = ring[i];
          const [bx, by] = ring[(i + 1) % ring.length];
          // half-open interval [min, max) avoids double-counting shared vertices
          if (ay <= scanY === by <= scanY) continue;
          xs.push(ax + ((scanY - ay) / (by - ay)) * (bx - ax));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const from = Math.max(0, Math.round(xs[k]));
        const to = Math.min(mask.width - 1, Math.round(xs[k + 1]) - 1);
        const row = py * mask.width;
        for (let px = from; px <= to; px++) {
          if (mask.data[row + px] < value) mask.data[row + px] = value;
        }
      }
    }
  },
};

/**
 * Stamp one segment as a capsule (distance-to-segment ≤ half), with a 0.5px
 * antialiased edge so thin residential streets don't shimmer against the grid.
 */
function stampSegment(
  mask: MutableMask,
  [ax, ay]: ScreenPoint,
  [bx, by]: ScreenPoint,
  half: number,
  value: number
): void {
  const pad = half + 1;
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - pad));
  const x1 = Math.min(mask.width - 1, Math.ceil(Math.max(ax, bx) + pad));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by) - pad));
  const y1 = Math.min(mask.height - 1, Math.ceil(Math.max(ay, by) + pad));
  if (x1 < x0 || y1 < y0) return;

  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy || 1;

  for (let py = y0; py <= y1; py++) {
    const cy = py + 0.5;
    const row = py * mask.width;
    for (let px = x0; px <= x1; px++) {
      const cx = px + 0.5;
      let t = ((cx - ax) * dx + (cy - ay) * dy) / lenSq;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = cx - (ax + t * dx);
      const qy = cy - (ay + t * dy);
      const d = Math.sqrt(qx * qx + qy * qy);
      const coverage = half + 0.5 - d;
      if (coverage <= 0) continue;
      const v = coverage >= 1 ? value : Math.round(value * coverage);
      if (mask.data[row + px] < v) mask.data[row + px] = v;
    }
  }
}

/** Nearest-pixel sample with clamping, like the mock's `sample`. */
export function sample(mask: Mask, x: number, y: number): number {
  const xi = clampIndex(Math.round(x), mask.width);
  const yi = clampIndex(Math.round(y), mask.height);
  return mask.data[yi * mask.width + xi];
}

/**
 * The mock's `sampleMax`: max of the center and 4 cross offsets at ±0.4·step,
 * so a street a hair off the dot lattice still registers.
 */
export function sampleMax5(mask: Mask, x: number, y: number, step: number): number {
  const o = step * 0.4;
  let m = sample(mask, x, y);
  m = Math.max(m, sample(mask, x + o, y));
  m = Math.max(m, sample(mask, x - o, y));
  m = Math.max(m, sample(mask, x, y + o));
  m = Math.max(m, sample(mask, x, y - o));
  return m;
}

function clampIndex(v: number, n: number): number {
  return v < 0 ? 0 : v >= n ? n - 1 : v;
}
