/** Dot lattice step in region-logical px, shared by the field and line overlays. */
export const DOT_STEP = 2;

/**
 * A zero-length dash with a round cap is a circle, not a short capsule.
 * Keep at least one diameter of clear space between dots, and a minimum
 * two-lattice-step cadence so thin, zoomed-out routes do not become solid.
 * Skia applies this to each batched path once per region, never per dot in JS.
 */
export function lineDotIntervals(width: number): [number, number] {
  return [0, Math.max(DOT_STEP * 2, width * 2)];
}
