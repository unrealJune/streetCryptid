import type { PackedAreas, PackedGeometry } from '../tiles/packed-geometry';
import { worldToScreen } from './camera';
import type { MaskRasterizer } from './raster';
import { softwareRasterizer } from './raster';
import { roadWidthFor } from './road-lod';
import { riverWidthFor } from './water-lod';
import type { CameraState, FeatureMasks, Mask, RoadClass, ScreenPoint, Viewport } from './types';

// Stroke widths live with the road/water LOD logic; re-exported here for the
// mask builders and tests that reference them alongside ROAD_VALUES.
export { ROAD_WIDTHS } from './road-lod';
export { RIVER_WIDTH } from './water-lod';

/** Mask values per road class 0–4 — the mock's RGRAY brightness ladder. */
export const ROAD_VALUES = [128, 170, 205, 225, 245] as const;

const FULL = 255;

/**
 * Rasterize geometry into the three coverage masks the dot field samples:
 * streets (brightness = road class), parks, and water (fills + stroked rivers).
 * Everything off-viewport costs nothing: stamps clamp to the mask bounds.
 *
 * Walks {@link PackedGeometry} coordinate pools directly; only the transient
 * projected point arrays a single feature needs are allocated at a time.
 */
export function buildFeatureMasks(
  geometry: PackedGeometry,
  camera: CameraState,
  viewport: Viewport,
  rasterizer: MaskRasterizer = softwareRasterizer
): FeatureMasks {
  const streets = rasterizer.createMask(viewport);
  const parks = rasterizer.createMask(viewport);
  const water = rasterizer.createMask(viewport);
  // Zoom-aware LOD, exactly like the streets below: without it a river keeps its
  // street-zoom weight while every road thins, and reads as a fat ribbon.
  const riverWidth = riverWidthFor(camera.zoom);

  for (const part of geometry.parts) {
    const { originX, originY } = part;
    const project = (x: number, y: number): ScreenPoint =>
      worldToScreen(camera, viewport, [originX + x, originY + y]);

    const s = part.streets;
    for (let i = 0; i < s.count; i++) {
      const roadClass = s.roadClass[i] as RoadClass;
      // Zoom-aware LOD: taper widths and omit the smallest classes when zoomed out.
      const width = roadWidthFor(roadClass, camera.zoom);
      if (width === null) continue;
      rasterizer.strokePolyline(
        streets,
        projectRange(s.coords, s.pointOff[i], s.pointOff[i + 1], project),
        width,
        ROAD_VALUES[roadClass]
      );
    }

    fillAreas(rasterizer, parks, part.parks, project);
    fillAreas(rasterizer, water, part.water, project);

    if (riverWidth !== null) {
      const r = part.rivers;
      for (let i = 0; i < r.count; i++) {
        rasterizer.strokePolyline(
          water,
          projectRange(r.coords, r.pointOff[i], r.pointOff[i + 1], project),
          riverWidth,
          FULL
        );
      }
    }
  }

  return { streets, parks, water };
}

/** Project one feature's [from,to) coordinate range into a fresh screen-point array. */
function projectRange(
  coords: Float32Array,
  from: number,
  to: number,
  project: (x: number, y: number) => ScreenPoint
): ScreenPoint[] {
  const out: ScreenPoint[] = new Array(to - from);
  for (let j = from; j < to; j++) out[j - from] = project(coords[j * 2], coords[j * 2 + 1]);
  return out;
}

function fillAreas(
  rasterizer: MaskRasterizer,
  mask: Mask,
  areas: PackedAreas,
  project: (x: number, y: number) => ScreenPoint
): void {
  for (let i = 0; i < areas.count; i++) {
    const rings: ScreenPoint[][] = [];
    for (let r = areas.ringOff[i]; r < areas.ringOff[i + 1]; r++) {
      rings.push(projectRange(areas.coords, areas.pointOff[r], areas.pointOff[r + 1], project));
    }
    rasterizer.fillPolygonEvenOdd(mask, rings, FULL);
  }
}
