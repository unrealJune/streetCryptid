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
 */

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

/** How a region's elevations map onto the 0–1 band value the shader reads. */
export interface ElevationBands {
  /** Elevation (m) of band value 0 — a multiple of {@link interval}. */
  readonly base: number;
  /** Metres between contours. */
  readonly interval: number;
}

/**
 * Elevation in metres for every mask pixel of a region, row-major, covering
 * `spec.rect` at `spec.maskWidth × spec.maskHeight`. Sea and bathymetry may be
 * negative; they are drawn as sea level.
 */
export interface ElevationRaster {
  readonly width: number;
  readonly height: number;
  readonly metres: Float32Array;
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
  const land: number[] = [];
  // Sampling every pixel of a 600×1200 mask is ~720k values; a stride keeps the
  // sort cheap and is plenty for two percentiles.
  const stride = Math.max(1, Math.floor(metres.length / 20000));
  for (let i = 0; i < metres.length; i += stride) if (metres[i] > 0) land.push(metres[i]);
  if (land.length < 16) return null;
  land.sort((a, b) => a - b);
  return [land[Math.floor(land.length * 0.01)], land[Math.floor((land.length - 1) * 0.995)]];
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
