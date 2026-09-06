import { clamp } from './color';
import type { AeroAreaKind, AeroLineKind } from './types';

/**
 * Building + aeroway stroke weights and their zoom/size cutoffs — the structure
 * twin of `road-lod.ts`, `water-lod.ts` and `transit-lod.ts`.
 *
 * Like transit and unlike streets, these are **region-logical px**: buildings and
 * runways are stroked as vectors over the finished region bitmap
 * (`render/structure-paths.ts`), not stamped as coverage into the feature mask,
 * so mask resolution never enters the arithmetic. The reason is the same one
 * `transit-lod.ts` gives: the dot lattice quantizes anything it touches, which
 * would turn a building outline into a scatter of unrelated dots.
 *
 * The load-bearing lever here is NOT a zoom cutoff but {@link BUILDING_MIN_PX}.
 * Filtering on **projected** size means large structures appear the moment the
 * tileset has them (z13) while small ones fade in as the camera closes, with no
 * per-zoom table to keep in step — and it stays correct at every latitude, which
 * a metre threshold would not: mercator's ground scale varies by cos(lat), so
 * the same building is ~1.5x more screen px in Seattle than at the equator.
 */

/**
 * Smallest projected footprint, in region-logical px, that earns an outline —
 * measured on the longer side of a building's bounding box.
 *
 * Below ~4 px an outline is a smudge indistinguishable from the dot field, and a
 * dense city block would contribute thousands of them to one batched path for no
 * legibility at all. Together with {@link BUILDING_MIN_ZOOM} it is what keeps a
 * z13 city shot from becoming mush: at z13 a 4.5 px footprint is a city block,
 * so only landmarks survive, and the threshold relaxes by 2x per zoom step from
 * there.
 *
 * Verified on Cologne (dense pre-war street grid, the worst case) and SeaTac at
 * z13–z16 with `scripts/map-shot.ts`.
 */
export const BUILDING_MIN_PX = 4.5;

/** Zoom at/below which buildings are dropped entirely (the tileset's own floor). */
export const BUILDING_MIN_ZOOM = 13;

/** Building outline stroke width, region-logical px. */
export const BUILDING_STROKE_WIDTH = 0.85;

/**
 * Building outline and fill opacity, over `palette.building`.
 *
 * Outline-plus-faint-fill alone was not enough: at a glance a block of them read
 * as one grey smudge, because the only thing separating two adjacent footprints
 * was a hairline of the same weight as everything else on the map. The fill
 * carries more of the read now, and the {@link BUILDING_HATCH_SPACING} lines
 * inside it give buildings a *material* the dot field does not have — the way a
 * printed map hatches built-up ground.
 */
export const BUILDING_STROKE_ALPHA = 0.62;
export const BUILDING_FILL_ALPHA = 0.05;

/**
 * Diagonal hatch inside each footprint: spacing between lines and their weight,
 * both region-logical px, plus the opacity they draw at.
 *
 * The hatch, not the fill, is what carries the texture — the flat fill is only
 * there to keep a footprint from reading as hollow between the lines. Tuned by
 * eye at z15/z16: any tighter than ~5 px and the lines blur into an even wash at
 * the 2x device ratio the region bitmap rasterizes at, which is exactly the flat
 * grey the hatch exists to avoid.
 *
 * Spacing does not vary with zoom — a texture is a screen-space property, and
 * the region bitmap is scaled by the camera like everything else.
 */
export const BUILDING_HATCH_SPACING = 5;
export const BUILDING_HATCH_WIDTH = 0.9;
export const BUILDING_HATCH_ALPHA = 0.42;

/**
 * Zoom at/below which the hatch is dropped and buildings are fill + outline only.
 * Below this a footprint is a handful of px across, so the hatch cannot resolve
 * and only muddies it.
 */
export const BUILDING_HATCH_MIN_ZOOM = 14;

/** Per-kind aeroway polygon treatment. */
export const AERO_AREA_STYLE: Record<
  AeroAreaKind,
  { readonly minZoom: number; readonly fillAlpha: number; readonly strokeAlpha: number }
> = {
  // The airport's property boundary. Outline only — a fill would tint an area
  // the size of the region.
  aerodrome: { minZoom: 9, fillAlpha: 0, strokeAlpha: 0.16 },
  // The paved ground planes stand on: the thing that makes an airport read as
  // built rather than blank.
  apron: { minZoom: 10, fillAlpha: 0.1, strokeAlpha: 0.2 },
};

/** Aerodrome boundaries are dashed, so they read as a limit and not a wall. */
export const AERODROME_DASH: readonly [number, number] = [6, 5];
export const AERODROME_STROKE_WIDTH = 1;

/** Base stroke width per aeroway line kind, region-logical px. */
export const AERO_LINE_WIDTHS: Record<AeroLineKind, number> = {
  runway: 4,
  taxiway: 1,
};

/** Below this camera zoom an aeroway line kind is omitted entirely. */
export const AERO_LINE_MIN_ZOOM: Record<AeroLineKind, number> = {
  runway: 10,
  taxiway: 12,
};

/** Aeroway line opacity: runways are the landmark, taxiways are texture. */
export const AERO_LINE_ALPHA: Record<AeroLineKind, number> = {
  runway: 0.52,
  taxiway: 0.22,
};

/**
 * Global structure stroke-width multiplier: full weight at z>=14, tapering to
 * 0.7 by z<=11 — the same taper `transitWidthScale` uses, so the whole
 * over-the-bitmap line layer thins together as the camera pulls back.
 */
export function structureWidthScale(zoom: number): number {
  return clamp(0.7 + (0.3 * (zoom - 11)) / 3, 0.7, 1);
}

/**
 * Effective building outline width (region-logical px) at a build zoom, or null
 * when buildings should be omitted entirely.
 */
export function buildingStrokeWidthFor(zoom: number): number | null {
  if (zoom < BUILDING_MIN_ZOOM) return null;
  return BUILDING_STROKE_WIDTH * structureWidthScale(zoom);
}

/**
 * Effective stroke width (region-logical px) for an aeroway line kind at a build
 * zoom, or null when the kind should be omitted. Signature matches
 * `roadWidthFor` / `transitWidthFor` so every "width or drop it" call site reads
 * the same.
 */
export function aeroLineWidthFor(kind: AeroLineKind, zoom: number): number | null {
  if (zoom < AERO_LINE_MIN_ZOOM[kind]) return null;
  return AERO_LINE_WIDTHS[kind] * structureWidthScale(zoom);
}

/** Whether footprints are hatched at `zoom` (they are always filled + outlined). */
export function buildingHatchVisible(zoom: number): boolean {
  return zoom >= BUILDING_HATCH_MIN_ZOOM;
}

/** Whether an aeroway polygon kind draws at `zoom`. */
export function aeroAreaVisible(kind: AeroAreaKind, zoom: number): boolean {
  return zoom >= AERO_AREA_STYLE[kind].minZoom;
}
