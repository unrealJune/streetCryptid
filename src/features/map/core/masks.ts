import { worldToScreen } from './camera';
import type { MaskRasterizer } from './raster';
import { softwareRasterizer } from './raster';
import { roadWidthFor } from './road-lod';
import type {
  CameraState,
  FeatureMasks,
  MapGeometry,
  ScreenPoint,
  Viewport,
  WorldPoint,
} from './types';

// Stroke widths live with the road LOD logic; re-exported here for the mask
// builders and tests that reference them alongside ROAD_VALUES / RIVER_WIDTH.
export { ROAD_WIDTHS } from './road-lod';

/** Mask values per road class 0–4 — the mock's RGRAY brightness ladder. */
export const ROAD_VALUES = [128, 170, 205, 225, 245] as const;

/** River stroke width, logical px (the mock draws rivers 5px into the water mask). */
export const RIVER_WIDTH = 5;

const FULL = 255;

/**
 * Rasterize geometry into the three coverage masks the dot field samples:
 * streets (brightness = road class), parks, and water (fills + stroked rivers).
 * Everything off-viewport costs nothing: stamps clamp to the mask bounds.
 */
export function buildFeatureMasks(
  geometry: MapGeometry,
  camera: CameraState,
  viewport: Viewport,
  rasterizer: MaskRasterizer = softwareRasterizer
): FeatureMasks {
  const project = (p: WorldPoint): ScreenPoint => worldToScreen(camera, viewport, p);
  const projectAll = (points: readonly WorldPoint[]) => points.map(project);

  const streets = rasterizer.createMask(viewport);
  for (const way of geometry.streets) {
    // Zoom-aware LOD: taper widths and omit the smallest classes when zoomed out.
    const width = roadWidthFor(way.roadClass, camera.zoom);
    if (width === null) continue;
    rasterizer.strokePolyline(streets, projectAll(way.points), width, ROAD_VALUES[way.roadClass]);
  }

  const parks = rasterizer.createMask(viewport);
  for (const park of geometry.parks) {
    rasterizer.fillPolygonEvenOdd(parks, park.rings.map(projectAll), FULL);
  }

  const water = rasterizer.createMask(viewport);
  for (const body of geometry.water) {
    rasterizer.fillPolygonEvenOdd(water, body.rings.map(projectAll), FULL);
  }
  for (const river of geometry.rivers) {
    rasterizer.strokePolyline(water, projectAll(river.points), RIVER_WIDTH, FULL);
  }

  return { streets, parks, water };
}
