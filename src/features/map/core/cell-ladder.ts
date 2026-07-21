/**
 * The camera-zoom → H3-resolution ladder. Exploration truth lives at res 10
 * (~131 m across ≈ the retired hex cells); coarser views aggregate to parent
 * cells shaded by explored fraction. One step down the ladder per 1.5 camera
 * zoom levels keeps cells-in-view bounded (~0.2–6k) at every zoom, which is
 * what lets the coverage layer stay on all the way out to the globe.
 */

/** The resolution exploration is recorded at — the data contract. */
export const H3_DISPLAY_RES = 10;

/** Coarsest ladder rung; res 2 has only 5,882 cells worldwide. */
export const H3_MIN_RES = 2;

/** Camera zoom at (and above) which the ladder sits at {@link H3_DISPLAY_RES}. */
export const H3_FULL_DETAIL_ZOOM = 14;

/** H3 resolution to build a region's cell field at, for a camera zoom. */
export function resForZoom(zoom: number): number {
  const steps = Math.ceil((H3_FULL_DETAIL_ZOOM - zoom) / 1.5);
  const res = H3_DISPLAY_RES - Math.max(0, steps);
  return Math.max(H3_MIN_RES, Math.min(H3_DISPLAY_RES, res));
}
