import { visibleWorldRect } from './camera';
import { resForZoom } from './cell-ladder';
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
 * Explored fraction (0–1) of fixed-resolution cells currently in view.
 * Returns zero while the exploration layer is disabled at low zoom.
 */
export function coverageInView(
  exploration: ExplorationIndex,
  grid: H3Grid,
  camera: CameraState,
  viewport: Viewport
): number {
  const resolution = resForZoom(camera.zoom);
  if (resolution === null) return 0;
  const cells = grid.cellsInRect(visibleWorldRect(camera, viewport), resolution);
  if (!cells.length) return 0;
  let total = 0;
  for (const cell of cells) total += exploration.fractionAt(cell);
  return total / cells.length;
}
