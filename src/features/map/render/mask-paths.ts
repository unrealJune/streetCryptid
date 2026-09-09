import { worldToScreen } from '../core/camera';
import { regionMaskCamera, type RegionSpec } from '../core/region';
import { roadClassVisible, roadWidthFor, type RoadLayerOptions } from '../core/road-lod';
import { riverWidthFor } from '../core/water-lod';
import type { ScreenPoint, WorldRect } from '../core/types';
import type { PackedAreas, PackedGeometry } from '../tiles/packed-geometry';
import { featureBounds, intersectsBounds, ringBounds, tileLocalRect } from './geometry-bounds';

/**
 * SVG path strings for a region's feature mask, in mask-pixel coordinates.
 *
 * Pure (no Skia): projects the region geometry through the same synthetic mask
 * camera the software rasterizer uses, then batches it into a handful of SVG
 * `M…L…` strings — one stroked path per road class, one non-zero fill for parks,
 * one for water, and one stroked path for rivers. The render layer feeds these to
 * `Skia.Path.MakeFromSVGString` (one parse per class) and strokes/fills them on
 * the GPU.
 *
 * Ring order is preserved exactly as decoded, because the fill relies on it:
 * MVT gives exterior rings clockwise and holes counter-clockwise, and the
 * batched path is filled non-zero so overlapping features union instead of
 * cancelling (see `mask-image.ts`).
 *
 * Walks {@link PackedGeometry} coordinate pools directly — points are read from
 * `Float32Array`s (delta + tile origin) and projected on the fly, never
 * materialized as tuples.
 */
export interface MaskPaths {
  /** One SVG polyline per road class (index = RoadClass 0..4); '' when empty. */
  readonly streets: readonly string[];
  /** Closed sub-paths for park fills (non-zero winding); '' when empty. */
  readonly park: string;
  /** Closed sub-paths for water fills (non-zero winding); '' when empty. */
  readonly water: string;
  /** SVG polyline for river centerlines; '' when empty. */
  readonly rivers: string;
}

type Project = (x: number, y: number) => ScreenPoint;

export function buildMaskPaths(
  geometry: PackedGeometry,
  spec: RegionSpec,
  layers?: RoadLayerOptions
): MaskPaths {
  const { camera, viewport } = regionMaskCamera(spec);

  // Zoom-aware LOD: mask-image drops the smallest road classes when zoomed out,
  // so skip building their paths entirely — at city zoom that's the majority of
  // streets (service/residential), the bulk of the per-region-swap projection
  // and string cost.
  // The highways layer toggle drops motorways the same way — no paths
  // built, so switching them off costs nothing extra to render.
  const classActive = [0, 1, 2, 3, 4].map(
    (cls) => roadWidthFor(cls, spec.zoom) !== null && roadClassVisible(cls, layers)
  );
  const riversActive = riverWidthFor(spec.zoom) !== null;

  const streets: string[][] = [[], [], [], [], []];
  const parkFills: string[] = [];
  const waterFills: string[] = [];
  const riverLines: string[] = [];

  for (const part of geometry.parts) {
    const { originX, originY } = part;
    const project: Project = (x, y) => worldToScreen(camera, viewport, [originX + x, originY + y]);
    // Widest mask stroke is 5px; leave its half-width plus AA at the edge.
    const rect = tileLocalRect(
      spec.rect,
      part,
      4 *
        Math.max(
          (spec.rect.maxX - spec.rect.minX) / spec.maskWidth,
          (spec.rect.maxY - spec.rect.minY) / spec.maskHeight
        )
    );

    const s = part.streets;
    const streetBounds = featureBounds(s);
    for (let i = 0; i < s.count; i++) {
      const rc = s.roadClass[i];
      if (!classActive[rc] || !intersectsBounds(streetBounds, i, rect)) continue;
      const line = polyline(s.coords, s.pointOff[i], s.pointOff[i + 1], project);
      if (line) streets[rc].push(line);
    }

    if (riversActive) {
      const r = part.rivers;
      const riverBounds = featureBounds(r);
      for (let i = 0; i < r.count; i++) {
        if (!intersectsBounds(riverBounds, i, rect)) continue;
        const line = polyline(r.coords, r.pointOff[i], r.pointOff[i + 1], project);
        if (line) riverLines.push(line);
      }
    }

    pushFills(waterFills, part.water, project, rect);
    pushFills(parkFills, part.parks, project, rect);
  }

  return {
    streets: streets.map((cls) => cls.join(' ')),
    park: parkFills.join(' '),
    water: waterFills.join(' '),
    rivers: riverLines.join(' '),
  };
}

/** An SVG "M…L…" open polyline in mask-pixel coordinates (1-decimal rounded). */
export function polyline(coords: Float32Array, from: number, to: number, project: Project): string {
  if (to - from < 2) return '';
  let out = '';
  for (let j = from; j < to; j++) {
    const [x, y] = project(coords[j * 2], coords[j * 2 + 1]);
    out += `${j === from ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return out;
}

/** Append one closed sub-path per ring of every area feature (filled non-zero). */
function pushFills(dst: string[], areas: PackedAreas, project: Project, rect: WorldRect): void {
  const bounds = featureBounds(areas);
  const rings = ringBounds(areas);
  for (let i = 0; i < areas.count; i++) {
    if (!intersectsBounds(bounds, i, rect)) continue;
    for (let r = areas.ringOff[i]; r < areas.ringOff[i + 1]; r++) {
      if (!intersectsBounds(rings, r, rect)) continue;
      const line = polyline(areas.coords, areas.pointOff[r], areas.pointOff[r + 1], project);
      if (line) dst.push(`${line}Z`);
    }
  }
}
