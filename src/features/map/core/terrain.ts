/** World-anchored terrain inputs, shared by the renderer and host screenshotter. */

import { worldToLatLon } from './mercator';
import type { RegionSpec } from './region';
import type { WorldRect } from './types';

/** Ground-texture code step: kind i (GROUND_KINDS index) is stored as `(i + 1) · step`. */
export const GROUND_CODE_STEP = 40;

/** The ground texture's red value for a GROUND_KINDS index. */
export function groundCode(kindIndex: number): number {
  return (kindIndex + 1) * GROUND_CODE_STEP;
}

/** Park-edge blur σ, region-logical px — the design note's "~9 px" boundary band. */
export const PARK_EDGE_PX = 9;

/** Hillshade contrast per metre of rise per projected metre, independent of zoom/crop. */
export const SHADE_GAIN = 1.5;
export const MERCATOR_CIRCUMFERENCE_M = 40075016.68557849;

/** Metres over which parkland fades from forest to alpine, centred on the treeline. */
export const ALPINE_FADE_M = 300;

/**
 * Approximate climatic treeline (m) at a latitude: ~3700 m through the
 * subtropics, falling 95 m per degree poleward to sea level near 67°. A
 * deliberately smooth global fit (~2000 m for the Alps, ~1800 m for the
 * Olympics, ~3000 m at Kyoto's latitude, ~600 m for southern Norway), tuned so
 * the Olympics' ridges read alpine at range zoom as they did under the old
 * relative treeline. What matters for the map is that it is a property of the
 * place, not of the view.
 */
export function treelineMetres(lat: number): number {
  return Math.max(0, 3700 - 95 * Math.max(0, Math.abs(lat) - 28));
}

/** 0 (forest) … 1 (alpine) for an elevation at a treeline: a smoothstep across {@link ALPINE_FADE_M}. */
export function alpineWeight(metres: number, treeline: number): number {
  const t = (metres - (treeline - ALPINE_FADE_M / 2)) / ALPINE_FADE_M;
  const c = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/**
 * Elevation in metres on a row-major grid covering `rect` edge to edge, at the
 * DEM's own resolution rather than the mask's: the shader samples it directly
 * with a bilinear filter. Sea and
 * bathymetry may be negative; they are drawn as sea level.
 */
export interface ElevationRaster {
  readonly width: number;
  readonly height: number;
  readonly metres: Float32Array;
  /** World rect the grid's outer pixel edges span. */
  readonly rect: WorldRect;
}

/** Where `raster` lands on `spec`'s mask, in mask pixels (may overhang the mask). */
export function rasterMaskRect(
  raster: ElevationRaster,
  spec: Pick<RegionSpec, 'rect' | 'maskWidth' | 'maskHeight'>
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  const sx = spec.maskWidth / (spec.rect.maxX - spec.rect.minX);
  const sy = spec.maskHeight / (spec.rect.maxY - spec.rect.minY);
  return {
    x: (raster.rect.minX - spec.rect.minX) * sx,
    y: (raster.rect.minY - spec.rect.minY) * sy,
    width: (raster.rect.maxX - raster.rect.minX) * sx,
    height: (raster.rect.maxY - raster.rect.minY) * sy,
  };
}

/** Nested absolute contours: zooming adds intermediate lines, never moves existing ones. */
export function contourLod(zoom: number): { interval: number; detail: number } {
  return {
    interval: Math.max(25, 100 * 2 ** (12 - Math.floor(zoom))),
    detail: zoom >= 15 ? 1 : zoom - Math.floor(zoom),
  };
}

/**
 * R/G = unsigned 16-bit elevation in metres, B = alpine weight. Sample this
 * image DIRECTLY with bilinear filtering, then decode R*65280 + G*255 in the
 * shader. Drawing the two bytes through an intermediate RGBA8 surface rounds
 * the high byte and introduces 256 m steps.
 *
 * No region statistics, sorting, or flat-region switch: a summit and a forest
 * keep the same encoding when another mountain enters the crop. Latitude is
 * measured per DEM row, not at the region centre, for the same reason.
 */
export function elevationRgba(raster: ElevationRaster): Uint8Array {
  const { metres, width, height, rect } = raster;
  const rgba = new Uint8Array(metres.length * 4);
  const dy = (rect.maxY - rect.minY) / height;
  for (let y = 0; y < height; y++) {
    const { lat } = worldToLatLon([0, rect.minY + (y + 0.5) * dy]);
    const alpineLo = treelineMetres(lat) - ALPINE_FADE_M / 2;
    for (let i = y * width, end = i + width; i < end; i++) {
      const m = Math.max(0, Math.min(65535, Math.round(metres[i])));
      const p = i * 4;
      rgba[p] = m >> 8;
      rgba[p + 1] = m & 255;
      const t = (m - alpineLo) / ALPINE_FADE_M;
      if (t > 0) rgba[p + 2] = t >= 1 ? 255 : t * t * (3 - 2 * t) * 255 + 0.5;
      rgba[p + 3] = 255;
    }
  }
  return rgba;
}
