import { visibleWorldRect } from './camera';
import { H3_DISPLAY_RES, resForZoom } from './cell-ladder';
import type { ExplorationIndex } from './exploration-index';
import type { H3Grid } from './h3-grid';
import type { CameraState, Place, Viewport, WorldPoint } from './types';

/** Kinds that make sense as a "where you are" headline, most local first. */
const PLACE_KINDS = new Set(['neighbourhood', 'suburb', 'quarter', 'village', 'town', 'city']);

/**
 * Nearest prominent place to `center`, for the island headline. Ignores kinds
 * that aren't localities (roads, POIs, …) and compares in squared world space.
 */
export function nearestPlaceName(places: readonly Place[], center: WorldPoint): string | null {
  let best: Place | null = null;
  let bestDist = Infinity;
  for (const place of places) {
    if (place.kind && !PLACE_KINDS.has(place.kind)) continue;
    const dx = place.world[0] - center[0];
    const dy = place.world[1] - center[1];
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      bestDist = d;
      best = place;
    }
  }
  return best?.name ?? null;
}

/**
 * Explored fraction (0–1) of DISPLAY-resolution cells currently in view.
 *
 * Deliberately narrower than the render ladder: the coarse rungs carry presence
 * rolled up from res 9 (`exploration-rollup.ts`), so measuring them would report
 * a city walk as most of a county. Below the res-9 band the layer keeps drawing
 * and this returns zero — `sectorsVisible` is what tells the chrome to hide the
 * readout rather than render a meaningless number.
 */
export function coverageInView(
  exploration: ExplorationIndex,
  grid: H3Grid,
  camera: CameraState,
  viewport: Viewport
): number {
  if (!coverageMeasurable(camera.zoom)) return 0;
  const cells = grid.cellsInRect(visibleWorldRect(camera, viewport), H3_DISPLAY_RES);
  if (!cells.length) return 0;
  let total = 0;
  for (const cell of cells) total += exploration.fractionAt(cell);
  return total / cells.length;
}

/**
 * Whether a coverage percentage means anything at `zoom` — i.e. whether the
 * ladder is on its display-resolution rung. The chrome hides the sector readout
 * when this is false; the map layer itself keeps drawing well past it.
 */
export function coverageMeasurable(zoom: number): boolean {
  return resForZoom(zoom) === H3_DISPLAY_RES;
}
