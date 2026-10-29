import { scaleFor } from '../core/camera';
import { clamp } from '../core/color';
import { DOT_STEP } from '../core/dot-style';
import type { RegionSpec } from '../core/region';
import { contourLod, MERCATOR_CIRCUMFERENCE_M, SHADE_GAIN } from '../core/terrain';
import type { MapPalette, WorldRect } from '../core/types';
import type { MapRegion } from '../engine/map-engine';

export { DOT_STEP } from '../core/dot-style';

/** Total float count of the shader's numeric uniform block, in declaration order. */
export const DOT_FIELD_UNIFORM_FLOATS = 46;

/** Procedural material coordinates never follow the region's build zoom. */
export const NOISE_WORLD_SCALE = scaleFor(12);
/** The shader wraps the hash itself too, so crossing a wrap cannot change the pattern. */
export const DOT_HASH_PERIOD = 12288;
const MAX_IMAGE_DIM = 2400;
const MAX_PIXEL_RATIO = 2;

/** At/above this build zoom the field renders full street detail (LOD 0). */
export const LOD_FULL_ZOOM = 14;
/** At/below this build zoom the field is fully simplified for a city view (LOD 1). */
export const LOD_COARSE_ZOOM = 11;

/**
 * The dot-field simplification factor for a build zoom: 0 = full street-level
 * detail, 1 = maximally simplified (areas fill solid, background noise thinned,
 * ghost lattice faded) so a zoomed-out city view reads as terrain, not stipple.
 */
export function lodForZoom(zoom: number): number {
  return clamp((LOD_FULL_ZOOM - zoom) / (LOD_FULL_ZOOM - LOD_COARSE_ZOOM), 0, 1);
}

export interface DotFieldUniformInput {
  readonly region: Pick<MapRegion, 'spec' | 'elevation'>;
  readonly palette: MapPalette;
  /** Render (device) pixels per region-logical pixel of the bitmap. */
  readonly pixelRatio: number;
  readonly step?: number;
  /** Load reveal 0..1 (1 = fully shown). Drives the cell-by-cell wipe. */
  readonly reveal?: number;
  /** LOD 0..1 override; defaults to {@link lodForZoom}(region build zoom). */
  readonly lod?: number;
  /** Whether discovered/unexplored styling is visible. */
  readonly explorationEnabled?: boolean;
  /** Whether the terrain texture carries absolute elevation. */
  readonly hasElevation?: boolean;
}

/**
 * Flatten everything the dot-field shader needs into the numeric uniform array,
 * in the exact declaration order of `DOT_FIELD_SKSL` (length
 * `DOT_FIELD_UNIFORM_FLOATS`). Camera-independent by design: the bitmap covers
 * the whole region rect at its anchor zoom, so it is reused across in-region
 * pans/zooms. All map math is region-local (world − rect.min), float32-safe.
 * Cell geometry lives entirely in the baked cell state texture now — the
 * shader takes no hex/cell uniforms. Pure — no Skia.
 */
export function packDotFieldUniforms({
  region,
  palette,
  pixelRatio,
  step = DOT_STEP,
  reveal = 1,
  lod,
  explorationEnabled = true,
  hasElevation = false,
}: DotFieldUniformInput): number[] {
  const { rect, maskWidth, maskHeight, zoom } = region.spec;
  const scale = scaleFor(zoom); // region-logical px per world unit at anchor zoom
  const lodValue = lod ?? lodForZoom(zoom);
  const rgb = (c: readonly [number, number, number]) => [c[0] / 255, c[1] / 255, c[2] / 255];
  // Keep the same world lattice between integer detail levels. A fractional
  // zoom rebuild must not reseed every dot under an otherwise unchanged map.
  const gridStep = dotGridStep(zoom, step);
  const gx = (rect.minX * scale) / gridStep;
  const gy = (rect.minY * scale) / gridStep;
  const elevation = hasElevation ? region.elevation : null;
  const ex = elevation ? (elevation.rect.maxX - elevation.rect.minX) / elevation.width : 1;
  const ey = elevation ? (elevation.rect.maxY - elevation.rect.minY) / elevation.height : 1;
  const contour = contourLod(zoom);

  return [
    pixelRatio, // uPixelRatio
    scale, // uScale
    rect.maxX - rect.minX,
    rect.maxY - rect.minY, // uRectSize
    maskWidth,
    maskHeight, // uMaskSize
    gridStep, // uStep
    ...rgb(palette.bg), // uBg
    reveal, // uReveal
    lodValue, // uLod
    explorationEnabled ? 1 : 0, // uExploration
    palette.effects?.neonGlow ?? 0, // uNeonGlow
    palette.effects?.scanlines ?? 0, // uScanlines
    rect.minX * NOISE_WORLD_SCALE,
    rect.minY * NOISE_WORLD_SCALE, // uNoiseOrigin
    hasElevation ? 1 : 0, // uHasElev
    SHADE_GAIN / (ex * MERCATOR_CIRCUMFERENCE_M), // uShadeGain, per DEM pixel
    NOISE_WORLD_SCALE / scale, // uNoiseScale
    wrapGrid(Math.floor(gx)),
    wrapGrid(Math.floor(gy)), // uGridOrigin
    (Math.floor(gx) + 0.5 - gx) * gridStep,
    (Math.floor(gy) + 0.5 - gy) * gridStep, // uGridPhase
    elevation ? (elevation.rect.minX - rect.minX) * scale : 0,
    elevation ? (elevation.rect.minY - rect.minY) * scale : 0, // uElevOrigin
    ex * scale,
    ey * scale, // uElevStep
    elevation?.width ?? 1,
    elevation?.height ?? 1, // uElevSize
    contour.interval,
    contour.detail,
    ...noiseWeights((NOISE_WORLD_SCALE / scale) * step * 2 * 0.045),
    ...noiseWeights((NOISE_WORLD_SCALE / scale) * step * 2 * 0.03),
    wrapGrid(Math.floor(gx / 2)),
    wrapGrid(Math.floor(gy / 2)), // uCoarseGridOrigin
    (Math.floor(gx / 2) + 0.5 - gx / 2) * gridStep * 2,
    (Math.floor(gy / 2) + 0.5 - gy / 2) * gridStep * 2, // uCoarseGridPhase
    atlasRows((rect.maxY - rect.minY) * scale, gridStep), // uAtlasSplit
    dotDetail(zoom).blend, // uDetailBlend
  ];
}

/** Filter against both lattices, preserving the mean as unresolved octaves fade out. */
function noiseWeights(frequency: number): number[] {
  const weights: number[] = [];
  for (let i = 0; i < 4; i++) {
    const t = clamp((frequency - 0.125) / (0.5 - 0.125), 0, 1);
    weights.push((2 ** (-i - 1) / (1 - 2 ** -4)) * (1 - t * t * (3 - 2 * t)));
    frequency *= 2.03;
  }
  return weights;
}

function wrapGrid(index: number): number {
  return ((index % DOT_HASH_PERIOD) + DOT_HASH_PERIOD) % DOT_HASH_PERIOD;
}

function dotGridStep(zoom: number, step = DOT_STEP): number {
  return step * 2 ** (zoom - dotDetail(zoom).level);
}

function dotDetail(zoom: number): { level: number; blend: number } {
  const level = Math.floor(zoom);
  const fraction = zoom - level;
  // Preserve the ordinary two-pixel field at integer zooms. Between levels,
  // blend in the next finer field; never replace the whole pattern in one step.
  return fraction <= 0.15
    ? { level, blend: 1 }
    : { level: level + 1, blend: clamp((fraction - 0.15) / 0.7, 0, 1) };
}

function atlasRows(height: number, step: number): number {
  return Math.ceil(height / step) + 3;
}

/** Two texels per dot, a neighbour halo, and the previous detail level underneath. */
export function dotAtlasSize(
  spec: RegionSpec,
  inputStep = DOT_STEP
): { width: number; height: number } {
  const logical = regionLogicalSize({ spec });
  const step = dotGridStep(spec.zoom, inputStep);
  return {
    width: (Math.ceil(logical.width / step) + 3) * 2,
    height:
      atlasRows(logical.height, step) +
      (dotDetail(spec.zoom).blend < 1 ? atlasRows(logical.height, step * 2) : 0),
  };
}

/** Region-logical bitmap size (px) at the region's anchor zoom, before the device multiplier. */
export function regionLogicalSize(region: Pick<MapRegion, 'spec'>): {
  width: number;
  height: number;
} {
  const { rect, zoom } = region.spec;
  const scale = scaleFor(zoom);
  return {
    width: (rect.maxX - rect.minX) * scale,
    height: (rect.maxY - rect.minY) * scale,
  };
}

export interface RegionImageLayout {
  readonly rect: WorldRect;
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  /** Canvas translation in device pixels, from data-region coordinates to bitmap coordinates. */
  readonly offsetX: number;
  readonly offsetY: number;
}

/** Anchor the FINAL bitmap's pixels too, including when its density is capped or fractional. */
export function regionImageLayout(spec: RegionSpec, quality = 1): RegionImageLayout {
  const nominal = spec.nominalSize ?? regionLogicalSize({ spec });
  const capped = Math.max(
    1,
    Math.min(MAX_PIXEL_RATIO, MAX_IMAGE_DIM / Math.max(nominal.width, nominal.height))
  );
  const pixelRatio = Math.max(0.5, capped * quality);
  const scale = scaleFor(spec.zoom) * pixelRatio;
  const x0 = Math.floor(spec.rect.minX * scale);
  const y0 = Math.floor(spec.rect.minY * scale);
  const width = Math.max(1, Math.ceil(spec.rect.maxX * scale) - x0);
  const height = Math.max(1, Math.ceil(spec.rect.maxY * scale) - y0);
  return {
    rect: {
      minX: x0 / scale,
      minY: y0 / scale,
      maxX: (x0 + width) / scale,
      maxY: (y0 + height) / scale,
    },
    width,
    height,
    pixelRatio,
    offsetX: spec.rect.minX * scale - x0,
    offsetY: spec.rect.minY * scale - y0,
  };
}
