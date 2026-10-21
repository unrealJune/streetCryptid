/**
 * Terrain inputs for the dot field: the ground-cover texture's encoding and the
 * elevation → contour-band normalization behind `terrainTex.g`.
 *
 * Pure (no Skia): the render layer turns what this returns into textures, and
 * the shader (`render/dot-field-sksl.ts`) reads them back with the same
 * constants.
 *
 * ## Why bands, not the region's min/max
 *
 * The design note normalizes elevation to the visible min/max and draws a
 * contour every 1/9 of that range, so the Alps are not a wall of lines and a
 * floodplain is not empty. Normalizing to the REGION's exact range would make
 * every contour move each time a pan builds the next region — the lines would
 * swim. So the range only chooses an interval from {@link CONTOUR_INTERVALS_M}
 * (the smallest that spans it in {@link CONTOUR_BANDS} bands), and the bands
 * start on a multiple of it: contours sit at real, absolute elevations (every
 * 50 m, say), and two neighbouring regions with similar relief draw the same
 * lines. `fract(h · CONTOUR_BANDS)` in the shader crosses 0 exactly on them.
 *
 * ## Why the treeline is in metres
 *
 * The band value is relative by construction, so anything keyed to it moves
 * whenever the view's relief does. The treeline was: parkland turned alpine in
 * the top ~15% of each region's bands, so a lowland valley's 300 m hilltops went
 * grey at one zoom and green again once a pan or zoom-out brought a real summit
 * into the region. It is now absolute ({@link treelineMetres}), carried per DEM
 * pixel in `terrainTex.b` ({@link alpineWeight}), and a hill is alpine or not
 * wherever you look at it from.
 */

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

/** Contour bands across a region's relief — the design note's "every 1/9 of the range". */
export const CONTOUR_BANDS = 9;

/** Candidate contour intervals, metres, smallest first. */
export const CONTOUR_INTERVALS_M = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000] as const;

/**
 * Below this much relief (metres) a region is treated as flat: no hillshade or
 * contours to draw, so the park falls back to the canopy texture rather than
 * drawing one stray contour across a floodplain.
 */
export const MIN_RELIEF_M = 15;

/** Hillshade contrast per unit of band value (`uShadeGain`), tuned on Kyoto at z9.5–z12. */
export const SHADE_GAIN = 6;

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

/** How a region's elevations map onto the 0–1 band value the shader reads. */
export interface ElevationBands {
  /** Elevation (m) of band value 0 — a multiple of {@link interval}. */
  readonly base: number;
  /** Metres between contours. */
  readonly interval: number;
}

/**
 * Elevation in metres on a row-major grid covering `rect` edge to edge, at the
 * DEM's own resolution rather than the mask's: the render layer stretches it
 * over the mask with a bilinear filter ({@link rasterMaskRect}). Sea and
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

/**
 * The contour interval and base for a region whose land spans `minM..maxM`, or
 * null when it is flatter than {@link MIN_RELIEF_M}. The chosen bands always
 * contain the whole range.
 */
export function elevationBands(minM: number, maxM: number): ElevationBands | null {
  const lo = Math.max(0, minM);
  const hi = Math.max(0, maxM);
  if (!(hi - lo >= MIN_RELIEF_M)) return null;
  for (const interval of CONTOUR_INTERVALS_M) {
    const base = Math.floor(lo / interval) * interval;
    if (hi - base <= CONTOUR_BANDS * interval) return { base, interval };
  }
  const interval = CONTOUR_INTERVALS_M[CONTOUR_INTERVALS_M.length - 1];
  return { base: Math.floor(lo / interval) * interval, interval };
}

/** Band value 0–1 for an elevation (clamped; sea level and below read as land at 0 m). */
export function bandValue(metres: number, bands: ElevationBands): number {
  const t = (Math.max(0, metres) - bands.base) / (CONTOUR_BANDS * bands.interval);
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

/**
 * The range a region's relief is measured over: robust percentiles of its land
 * (above 0 m), so one bad DEM pixel or a single mast-tip spike cannot stretch
 * the bands. Null when there is too little land to say.
 */
export function reliefRange(metres: Float32Array): readonly [number, number] | null {
  // A stride keeps the sort cheap and is plenty for two percentiles.
  const stride = Math.max(1, Math.floor(metres.length / 20000));
  const sampled = new Float32Array(Math.ceil(metres.length / stride));
  let count = 0;
  for (let i = 0; i < metres.length; i += stride) if (metres[i] > 0) sampled[count++] = metres[i];
  if (count < 16) return null;
  // A typed-array sort is numeric and native; a comparator sort calls back into JS per compare.
  const land = sampled.subarray(0, count).sort();
  return [land[Math.floor(count * 0.01)], land[Math.floor((count - 1) * 0.995)]];
}

/**
 * Encode a region's elevation as 8-bit band values (the `terrainTex.g` channel),
 * or null when the region is flat or has no land — the shader then draws the
 * canopy fallback.
 */
export function encodeElevationBands(
  raster: ElevationRaster
): { readonly bytes: Uint8Array; readonly bands: ElevationBands } | null {
  const range = reliefRange(raster.metres);
  if (!range) return null;
  const bands = elevationBands(range[0], range[1]);
  if (!bands) return null;
  const bytes = new Uint8Array(raster.width * raster.height);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.round(bandValue(raster.metres[i], bands) * 255);
  }
  return { bytes, bands };
}

/**
 * {@link encodeElevationBands} as the `terrainTex` pixels it becomes: opaque
 * RGBA at the raster's size with the band in G, the {@link alpineWeight} in B,
 * and R left 0 for the park edge. One treeline serves the whole raster, taken
 * at its centre's latitude (a region spans a degree or two at most where there
 * is relief to draw).
 */
export function elevationBandsRgba(raster: ElevationRaster): Uint8Array | null {
  const range = reliefRange(raster.metres);
  if (!range) return null;
  const bands = elevationBands(range[0], range[1]);
  if (!bands) return null;
  // `bandValue` inlined, in one pass: this runs on the JS thread for every region
  // build, and a call per pixel is most of its cost under Hermes.
  const { metres } = raster;
  const span = CONTOUR_BANDS * bands.interval;
  const { rect } = raster;
  const { lat } = worldToLatLon([(rect.minX + rect.maxX) / 2, (rect.minY + rect.maxY) / 2]);
  const alpineLo = treelineMetres(lat) - ALPINE_FADE_M / 2;
  const rgba = new Uint8Array(metres.length * 4);
  for (let i = 0, p = 1; i < metres.length; i++, p += 4) {
    const m = metres[i];
    const v = (((m > 0 ? m : 0) - bands.base) / span) * 255;
    rgba[p] = v <= 0 ? 0 : v >= 255 ? 255 : v + 0.5; // Uint8Array truncates: round half up
    // alpineWeight, inlined for the same reason.
    const t = (m - alpineLo) / ALPINE_FADE_M;
    if (t > 0) rgba[p + 1] = t >= 1 ? 255 : t * t * (3 - 2 * t) * 255 + 0.5;
    rgba[p + 2] = 255;
  }
  return rgba;
}
