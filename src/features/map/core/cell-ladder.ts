/**
 * Exploration uses one fixed H3 resolution. Below the render threshold those
 * cells become too small to read, so the coverage layer is disabled instead of
 * aggregating occupancy into progressively coarser parents.
 */

/** The resolution exploration is recorded at — the data contract. */
export const H3_DISPLAY_RES = 9;

/** Smallest camera zoom at which res-9 cells remain useful on screen. */
export const H3_MIN_RENDER_ZOOM = 12.5;

/** Fixed H3 resolution to render, or null when exploration should be hidden. */
export function resForZoom(zoom: number): number | null {
  return zoom >= H3_MIN_RENDER_ZOOM ? H3_DISPLAY_RES : null;
}
