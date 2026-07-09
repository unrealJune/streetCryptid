import { worldToScreen } from '../core/camera';
import { regionMaskCamera, type RegionSpec } from '../core/region';
import type { MapGeometry, WorldPoint } from '../core/types';

/**
 * SVG path strings for a region's feature mask, in mask-pixel coordinates.
 *
 * Pure (no Skia): projects the region geometry through the same synthetic mask
 * camera the software rasterizer uses, then batches it into a handful of SVG
 * `M…L…` strings — one stroked path per road class, one even-odd fill for parks,
 * one for water, and one stroked path for rivers. The render layer feeds these to
 * `Skia.Path.MakeFromSVGString` (one parse per class) and strokes/fills them on
 * the GPU. Keeping this pure lets the projection be unit-tested and diffed against
 * the software mask headlessly.
 */
export interface MaskPaths {
  /** One SVG polyline per road class (index = RoadClass 0..4); '' when empty. */
  readonly streets: readonly string[];
  /** Even-odd closed sub-paths for park fills; '' when empty. */
  readonly park: string;
  /** Even-odd closed sub-paths for water fills; '' when empty. */
  readonly water: string;
  /** SVG polyline for river centerlines; '' when empty. */
  readonly rivers: string;
}

export function buildMaskPaths(geometry: MapGeometry, spec: RegionSpec): MaskPaths {
  const { camera, viewport } = regionMaskCamera(spec);
  const project = (p: WorldPoint): WorldPoint => worldToScreen(camera, viewport, p);

  const streets: string[][] = [[], [], [], [], []];
  for (const way of geometry.streets) {
    streets[way.roadClass].push(polyline(way.points, project));
  }

  return {
    streets: streets.map((cls) => cls.filter(Boolean).join(' ')),
    park: fills(
      geometry.parks.flatMap((a) => a.rings),
      project
    ),
    water: fills(
      geometry.water.flatMap((a) => a.rings),
      project
    ),
    rivers: geometry.rivers
      .map((r) => polyline(r.points, project))
      .filter(Boolean)
      .join(' '),
  };
}

/** An SVG "M…L…" open polyline in mask-pixel coordinates (1-decimal rounded). */
export function polyline(
  points: readonly WorldPoint[],
  project: (p: WorldPoint) => WorldPoint
): string {
  if (points.length < 2) return '';
  let out = '';
  for (let i = 0; i < points.length; i++) {
    const [x, y] = project(points[i]);
    out += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return out;
}

/** SVG closed sub-paths (one per ring) for an even-odd fill. */
export function fills(
  rings: readonly (readonly WorldPoint[])[],
  project: (p: WorldPoint) => WorldPoint
): string {
  return rings
    .map((ring) => {
      const line = polyline(ring, project);
      return line ? `${line}Z` : '';
    })
    .filter(Boolean)
    .join(' ');
}
