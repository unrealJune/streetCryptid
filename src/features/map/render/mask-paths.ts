import { worldToScreen } from '../core/camera';
import { regionMaskCamera, type RegionSpec } from '../core/region';
import { roadWidthFor } from '../core/road-lod';
import type { ScreenPoint } from '../core/types';
import type { PackedAreas, PackedGeometry } from '../tiles/packed-geometry';

/**
 * SVG path strings for a region's feature mask, in mask-pixel coordinates.
 *
 * Pure (no Skia): projects the region geometry through the same synthetic mask
 * camera the software rasterizer uses, then batches it into a handful of SVG
 * `M…L…` strings — one stroked path per road class, one even-odd fill for parks,
 * one for water, and one stroked path for rivers. The render layer feeds these to
 * `Skia.Path.MakeFromSVGString` (one parse per class) and strokes/fills them on
 * the GPU.
 *
 * Walks {@link PackedGeometry} coordinate pools directly — points are read from
 * `Float32Array`s (delta + tile origin) and projected on the fly, never
 * materialized as tuples.
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

type Project = (x: number, y: number) => ScreenPoint;

export function buildMaskPaths(geometry: PackedGeometry, spec: RegionSpec): MaskPaths {
  const { camera, viewport } = regionMaskCamera(spec);

  // Zoom-aware LOD: mask-image drops the smallest road classes when zoomed out,
  // so skip building their paths entirely — at city zoom that's the majority of
  // streets (service/residential), the bulk of the per-region-swap projection
  // and string cost.
  const classActive = [0, 1, 2, 3, 4].map((cls) => roadWidthFor(cls, spec.zoom) !== null);

  const streets: string[][] = [[], [], [], [], []];
  const parkFills: string[] = [];
  const waterFills: string[] = [];
  const riverLines: string[] = [];

  for (const part of geometry.parts) {
    const { originX, originY } = part;
    const project: Project = (x, y) => worldToScreen(camera, viewport, [originX + x, originY + y]);

    const s = part.streets;
    for (let i = 0; i < s.count; i++) {
      const rc = s.roadClass[i];
      if (!classActive[rc]) continue;
      const line = polyline(s.coords, s.pointOff[i], s.pointOff[i + 1], project);
      if (line) streets[rc].push(line);
    }

    const r = part.rivers;
    for (let i = 0; i < r.count; i++) {
      const line = polyline(r.coords, r.pointOff[i], r.pointOff[i + 1], project);
      if (line) riverLines.push(line);
    }

    pushFills(waterFills, part.water, project);
    pushFills(parkFills, part.parks, project);
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

/** Append one even-odd closed sub-path per ring of every area feature. */
function pushFills(dst: string[], areas: PackedAreas, project: Project): void {
  for (let i = 0; i < areas.count; i++) {
    for (let r = areas.ringOff[i]; r < areas.ringOff[i + 1]; r++) {
      const line = polyline(areas.coords, areas.pointOff[r], areas.pointOff[r + 1], project);
      if (line) dst.push(`${line}Z`);
    }
  }
}
