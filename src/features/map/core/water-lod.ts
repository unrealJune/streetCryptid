import { clamp } from './color';

/**
 * River stroke width and its zoom taper — the water twin of `road-lod.ts`.
 *
 * Widths here are **mask px**, like {@link ROAD_WIDTHS}: rivers are coverage
 * stamped into the water channel of the feature mask, not line work drawn over
 * the finished bitmap (that's `structure-lod.ts`). The mask is rasterized at
 * `maskScale` (0.4) of logical resolution, so one mask px is ~2.5 logical px on
 * screen — which is exactly the trap the old fixed `RIVER_WIDTH = 5` fell into.
 * It was lifted verbatim from the design mock, where the mask canvas was 1:1
 * with the screen and rivers (5) sat just under primaries (5.4) and well under
 * motorways (7.0). Carried into the app unchanged, that same 5 became ~12.5
 * logical px — wider than the mock's motorway — and, unlike every road class,
 * it never tapered, so zooming out thinned the entire street ladder to 0.4×
 * while the rivers stayed put and swelled into ribbons across the continent.
 */

/**
 * Base river stroke width at full detail, mask px. Sized off the same ladder as
 * {@link ROAD_WIDTHS}: the mock put a river at roughly a primary road's weight,
 * so this tracks `ROAD_WIDTHS[3]` (3.8) rather than a motorway's 5.0.
 */
export const RIVER_WIDTH = 3.6;

/**
 * Floor of the width taper. Deeper than the road ladder's 0.4 because rivers
 * have no per-class LOD to thin them out: OpenMapTiles keeps drainage networks
 * in the `waterway` layer all the way out to z4, so at continental zoom a whole
 * basin's tributaries are on screen at once and each one has to stay slight.
 */
export const RIVER_MIN_SCALE = 0.3;

/** Zoom at/above which rivers draw at full {@link RIVER_WIDTH}. */
export const RIVER_FULL_ZOOM = 15;
/** Zoom at/below which rivers are pinned to {@link RIVER_MIN_SCALE}. */
export const RIVER_COARSE_ZOOM = 9;

/**
 * Global river stroke-width multiplier: full weight at z>=15, tapering to
 * {@link RIVER_MIN_SCALE} by z<=9. Spans a wider zoom band than
 * `roadWidthScale` so the taper is still working through the regional zooms
 * (z9–z12) where a river network first fills the screen.
 */
export function riverWidthScale(zoom: number): number {
  const span = RIVER_FULL_ZOOM - RIVER_COARSE_ZOOM;
  return clamp(
    RIVER_MIN_SCALE + ((1 - RIVER_MIN_SCALE) * (zoom - RIVER_COARSE_ZOOM)) / span,
    RIVER_MIN_SCALE,
    1
  );
}

/**
 * Effective mask-px stroke width for river centerlines at a build zoom, or null
 * when rivers should be omitted entirely. Never null today — the tileset's own
 * per-class zoom cutoffs already do the decluttering, so the taper alone is
 * enough — but the signature matches `roadWidthFor`/`transitWidthFor` so the
 * mask builders share one "width or drop it" shape.
 */
export function riverWidthFor(zoom: number): number | null {
  return RIVER_WIDTH * riverWidthScale(zoom);
}
