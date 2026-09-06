/**
 * Which H3 resolution the exploration layer draws at, per camera zoom.
 *
 * Exploration is RECORDED at one fixed resolution ({@link H3_DISPLAY_RES}) — that
 * is the data contract and it never changes. What varies is what gets DRAWN: below
 * the res-9 render floor those cells shrink past legibility, so instead of hiding
 * the layer entirely the map climbs a ladder of coarser ancestors, each carrying
 * presence rolled up from the res-9 truth (see `exploration-rollup.ts`).
 *
 * The ladder's spacing is not a taste knob. H3 edge length shrinks by √7 per
 * resolution step, so one step coarser is worth exactly log2(√7) ≈ 1.404 zoom
 * levels — hold that and every band shows cells the same on-screen size as the
 * res-9 floor already proved readable.
 */

/** The resolution exploration is recorded at — the data contract. */
export const H3_DISPLAY_RES = 9;

/** Smallest camera zoom at which res-9 cells remain useful on screen. */
export const H3_MIN_RENDER_ZOOM = 12.5;

/**
 * Coarsest rung of the ladder (~22 km edge). Below it the layer hides: a res-3
 * cell spans most of a country, and at that scale a rolled-up presence bloom
 * stops describing anywhere you have actually been. It is also where the ocean
 * cryptid layer takes over (see `ocean-cryptids.ts`).
 */
export const H3_COARSEST_RES = 4;

/** Zoom levels per resolution step — H3 edges shrink by √7 each step. */
const ZOOM_PER_RES = Math.log2(Math.sqrt(7));

/**
 * Step to the coarser resolution slightly before it is strictly needed. Cells
 * enter each band a little larger, which keeps the coarsest band's cell count
 * (region pad grows at low zoom) inside the envelope res 9 already proved at
 * z12.5 — roughly 7k cells. This is the lever to pull if profiling disagrees.
 */
const RES_STEP_BIAS = 0.45;

/**
 * Lowest camera zoom that still draws exploration. Derived, not typed in, so it
 * cannot drift from the ladder: it is where {@link resForZoom} stops returning a
 * resolution ≥ {@link H3_COARSEST_RES}.
 */
export const H3_MIN_LADDER_ZOOM =
  H3_MIN_RENDER_ZOOM + RES_STEP_BIAS - (H3_DISPLAY_RES - H3_COARSEST_RES) * ZOOM_PER_RES;

/**
 * H3 resolution to render at `zoom`, or null when exploration should be hidden.
 * Monotonically non-increasing as the camera pulls back: res 9 at street zoom,
 * one step coarser per ~1.4 levels, then null past {@link H3_COARSEST_RES}.
 */
export function resForZoom(zoom: number): number | null {
  if (zoom >= H3_MIN_RENDER_ZOOM) return H3_DISPLAY_RES;
  const steps = Math.ceil((H3_MIN_RENDER_ZOOM - zoom + RES_STEP_BIAS) / ZOOM_PER_RES);
  const res = H3_DISPLAY_RES - steps;
  return res >= H3_COARSEST_RES ? res : null;
}
