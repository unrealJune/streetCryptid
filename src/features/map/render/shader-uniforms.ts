import { scaleFor } from '../core/camera';
import { clamp } from '../core/color';
import type { MapPalette } from '../core/types';
import type { MapRegion } from '../engine/map-engine';

/** Dot lattice step in logical px — the mock's S (was `scene.DOT_STEP`). */
export const DOT_STEP = 2.0;

/** Total float count of the shader's numeric uniform block, in declaration order. */
export const DOT_FIELD_UNIFORM_FLOATS = 13;

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
  readonly region: MapRegion;
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
}: DotFieldUniformInput): number[] {
  const { rect, maskWidth, maskHeight, zoom } = region.spec;
  const scale = scaleFor(zoom); // region-logical px per world unit at anchor zoom
  const lodValue = lod ?? lodForZoom(zoom);
  const rgb = (c: readonly [number, number, number]) => [c[0] / 255, c[1] / 255, c[2] / 255];

  return [
    pixelRatio, // uPixelRatio
    scale, // uScale
    rect.maxX - rect.minX,
    rect.maxY - rect.minY, // uRectSize
    maskWidth,
    maskHeight, // uMaskSize
    step, // uStep
    ...rgb(palette.bg), // uBg
    reveal, // uReveal
    lodValue, // uLod
    explorationEnabled ? 1 : 0, // uExploration
  ];
}

/** Region-logical bitmap size (px) at the region's anchor zoom, before the device multiplier. */
export function regionLogicalSize(region: MapRegion): { width: number; height: number } {
  const { rect, zoom } = region.spec;
  const scale = scaleFor(zoom);
  return {
    width: (rect.maxX - rect.minX) * scale,
    height: (rect.maxY - rect.minY) * scale,
  };
}
