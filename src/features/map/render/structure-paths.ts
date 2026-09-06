import { scaleFor } from '../core/camera';
import type { RegionSpec } from '../core/region';
import {
  aeroAreaVisible,
  aeroLineWidthFor,
  buildingStrokeWidthFor,
  BUILDING_HATCH_SPACING,
  BUILDING_MIN_PX,
} from '../core/structure-lod';
import {
  AERO_AREA_KINDS,
  AERO_LINE_KINDS,
  type AeroAreaKind,
  type AeroLineKind,
  type WorldPoint,
} from '../core/types';
import type { PackedAreas, PackedGeometry } from '../tiles/packed-geometry';

/**
 * Pure SVG-path builder for the building + aeroway layer (the `mask-paths.ts` /
 * `transit-paths.ts` pattern: no Skia, unit-testable, one parse per batch on the
 * render side).
 *
 * Unlike streets and transit, none of this bakes into the feature mask: the
 * dot field quantizes everything it touches to the lattice, which would scatter
 * a building outline into unrelated dots. These are stroked and filled as vectors
 * over the finished region bitmap, in **region-logical px** (0 at rect.min,
 * `scaleFor(spec.zoom)` px per world unit) — the same space the ghost lattice,
 * frontier rim and transit lines use.
 *
 * Buildings are filtered by projected size, not by zoom alone: see
 * {@link BUILDING_MIN_PX}. The bounding box falls out of the projection loop, so
 * the filter costs nothing beyond the four comparisons it already needs.
 */
export interface StructurePaths {
  /** Closed sub-paths for building footprints (non-zero winding); '' when empty. */
  readonly buildings: string;
  /** Closed sub-paths per aeroway polygon kind; absent when nothing to draw. */
  readonly aeroAreas: Partial<Record<AeroAreaKind, string>>;
  /** One SVG polyline batch per aeroway line kind; absent when nothing to draw. */
  readonly aeroLines: Partial<Record<AeroLineKind, string>>;
}

type Project = (x: number, y: number) => WorldPoint;

export function buildStructurePaths(geometry: PackedGeometry, spec: RegionSpec): StructurePaths {
  const scale = scaleFor(spec.zoom);
  const { minX, minY } = spec.rect;

  // Zoom LOD: skip building the paths for anything that won't be drawn at all.
  const buildingsActive = buildingStrokeWidthFor(spec.zoom) !== null;
  const areaActive = AERO_AREA_KINDS.map((kind) => aeroAreaVisible(kind, spec.zoom));
  const lineActive = AERO_LINE_KINDS.map((kind) => aeroLineWidthFor(kind, spec.zoom) !== null);

  const buildingFills: string[] = [];
  const areaFills: string[][] = AERO_AREA_KINDS.map(() => []);
  const lineBatches: string[][] = AERO_LINE_KINDS.map(() => []);

  for (const part of geometry.parts) {
    const { originX, originY } = part;
    const project: Project = (x, y) => [(originX + x - minX) * scale, (originY + y - minY) * scale];

    if (buildingsActive) {
      const b = part.buildings;
      for (let i = 0; i < b.count; i++) {
        if (!spansMinPx(b, i, project)) continue;
        pushRings(buildingFills, b, i, project);
      }
    }

    const aa = part.aeroAreas;
    for (let i = 0; i < aa.count; i++) {
      const kind = aa.kind[i];
      if (!areaActive[kind]) continue;
      pushRings(areaFills[kind], aa, i, project);
    }

    const al = part.aeroLines;
    for (let i = 0; i < al.count; i++) {
      const kind = al.kind[i];
      if (!lineActive[kind]) continue;
      const line = polyline(al.coords, al.pointOff[i], al.pointOff[i + 1], project);
      if (line) lineBatches[kind].push(line);
    }
  }

  const aeroAreas: Partial<Record<AeroAreaKind, string>> = {};
  for (let i = 0; i < AERO_AREA_KINDS.length; i++) {
    if (areaFills[i].length) aeroAreas[AERO_AREA_KINDS[i]] = areaFills[i].join(' ');
  }
  const aeroLines: Partial<Record<AeroLineKind, string>> = {};
  for (let i = 0; i < AERO_LINE_KINDS.length; i++) {
    if (lineBatches[i].length) aeroLines[AERO_LINE_KINDS[i]] = lineBatches[i].join(' ');
  }

  return { buildings: buildingFills.join(' '), aeroAreas, aeroLines };
}

/**
 * Whether area feature `i`'s outer ring spans at least {@link BUILDING_MIN_PX} on
 * its longer side once projected. Only the first ring is measured: MVT lists the
 * exterior boundary first, and a hole can never be larger than what contains it.
 */
function spansMinPx(areas: PackedAreas, i: number, project: Project): boolean {
  const ring = areas.ringOff[i];
  if (ring >= areas.ringOff[i + 1]) return false;
  const from = areas.pointOff[ring];
  const to = areas.pointOff[ring + 1];
  if (to - from < 3) return false;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let j = from; j < to; j++) {
    const [x, y] = project(areas.coords[j * 2], areas.coords[j * 2 + 1]);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return Math.max(maxX - minX, maxY - minY) >= BUILDING_MIN_PX;
}

/** Append one closed sub-path per ring of area feature `i`. */
function pushRings(dst: string[], areas: PackedAreas, i: number, project: Project): void {
  for (let r = areas.ringOff[i]; r < areas.ringOff[i + 1]; r++) {
    const line = polyline(areas.coords, areas.pointOff[r], areas.pointOff[r + 1], project);
    if (line) dst.push(`${line}Z`);
  }
}

/**
 * The 45° hatch that fills building footprints, as one batched SVG path in
 * region-logical px covering the whole region rect.
 *
 * It is generated for the rect rather than per footprint because the renderer
 * clips it to the batched building path — one clip and one draw for every
 * building in the region, instead of a per-feature loop that would re-derive the
 * same lines thousands of times.
 *
 * Lines run down-right along `x - y = c`. Sweeping `c` from `-height` to `width`
 * covers every point of the box, since a point (x, y) inside it has
 * `x - y` in exactly that interval.
 */
export function buildHatchPath(spec: RegionSpec, spacing = BUILDING_HATCH_SPACING): string {
  const scale = scaleFor(spec.zoom);
  const width = (spec.rect.maxX - spec.rect.minX) * scale;
  const height = (spec.rect.maxY - spec.rect.minY) * scale;
  if (!(spacing > 0) || width <= 0 || height <= 0) return '';

  const lines: string[] = [];
  for (let c = -height; c <= width; c += spacing) {
    lines.push(`M${c.toFixed(1)} 0L${(c + height).toFixed(1)} ${height.toFixed(1)}`);
  }
  return lines.join(' ');
}

/** An SVG "M…L…" open polyline in region-logical px (1-decimal rounded). */
function polyline(coords: Float32Array, from: number, to: number, project: Project): string {
  if (to - from < 2) return '';
  let out = '';
  for (let j = from; j < to; j++) {
    const [x, y] = project(coords[j * 2], coords[j * 2 + 1]);
    out += `${j === from ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return out;
}
