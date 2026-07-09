import { visibleWorldRect } from './camera';
import { coverageOf, type ExplorationState } from './exploration';
import type { HexGrid } from './hex';
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

/** Discovered fraction (0–1) of the hex sectors currently in view. */
export function coverageInView(
  exploration: ExplorationState,
  grid: HexGrid,
  camera: CameraState,
  viewport: Viewport
): number {
  return coverageOf(exploration, grid.cellsIn(visibleWorldRect(camera, viewport)));
}
