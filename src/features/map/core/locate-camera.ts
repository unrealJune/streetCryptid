import type { CameraState, Viewport, WorldPoint } from './types';
import { coversView, type RegionSpec } from './region';

export const LOCATE_MIN_ZOOM = 13;
const COLD_LOCATE_MAX_ZOOM = 15;

/** Cold destinations open at street zoom; nearby/covered locates preserve detail. */
export function locateCamera(
  current: CameraState,
  center: WorldPoint,
  viewport: Viewport,
  region: RegionSpec | null,
  minZoom: number,
  maxZoom: number
): CameraState {
  const zoom = Math.max(minZoom, Math.min(maxZoom, Math.max(current.zoom, LOCATE_MIN_ZOOM)));
  const target = { center, zoom };
  return region && coversView(region, target, viewport)
    ? target
    : { center, zoom: Math.max(minZoom, Math.min(zoom, COLD_LOCATE_MAX_ZOOM)) };
}
