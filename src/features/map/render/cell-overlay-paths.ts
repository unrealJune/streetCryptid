import { scaleFor, worldToScreen } from '../core/camera';
import type { RegionCellField } from '../core/cell-field';
import { regionMaskCamera, type RegionSpec } from '../core/region';
import type { WorldPoint } from '../core/types';

/**
 * Pure SVG-path builders for the H3 cell layer (mask-paths.ts pattern: no Skia,
 * unit-testable, one parse per batch on the render side).
 *
 * Two coordinate spaces on purpose:
 * - State FILLS bake into the mask-resolution cell texture, so they project
 *   through the same synthetic mask camera as the feature masks.
 * - The ghost LATTICE and frontier RIM are 1–1.25 logical-px line features; at
 *   mask resolution (~2.5 logical px/texel) they'd render blocky, so they're
 *   stroked as vector paths in region-logical px directly onto the region
 *   bitmap, after the dot-field pass.
 */

/** One cell's closed outline plus the RGBA-channel state to fill it with. */
export interface CellFill {
  readonly path: string;
  /** 'rgb(r,g,b)' encoding R=fraction G=jitter B=reveal order, each 0–255. */
  readonly color: string;
}

const to255 = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));

/** Per-cell state fills in mask-pixel coords, for the cell state texture. */
export function cellStateFills(field: RegionCellField, spec: RegionSpec): CellFill[] {
  const { camera, viewport } = regionMaskCamera(spec);
  const project = (p: WorldPoint): WorldPoint => worldToScreen(camera, viewport, p);
  const fills: CellFill[] = [];
  for (const cell of field.cells) {
    const path = ring(cell.boundary, project);
    if (!path) continue;
    fills.push({
      path,
      color: `rgb(${to255(cell.fraction)},${to255(cell.jitter)},${to255(cell.order)})`,
    });
  }
  return fills;
}

/** One cell's projected boundary (mask px) + fill color. */
export interface CellFillGeometry {
  readonly points: readonly WorldPoint[];
  readonly color: string;
}

/**
 * Like {@link cellStateFills} but returns each cell's projected boundary points
 * directly instead of an SVG string. The renderer builds Skia paths from these
 * with `moveTo`/`lineTo`, avoiding a per-cell string build (`toFixed` per point)
 * and `MakeFromSVGString` parse — the bulk of the cell-state-texture cost at the
 * thousands of cells a region carries.
 */
export function cellStateFillGeometry(
  field: RegionCellField,
  spec: RegionSpec
): CellFillGeometry[] {
  const { camera, viewport } = regionMaskCamera(spec);
  const project = (p: WorldPoint): WorldPoint => worldToScreen(camera, viewport, p);
  const out: CellFillGeometry[] = [];
  for (const cell of field.cells) {
    if (cell.boundary.length < 3) continue;
    out.push({
      points: cell.boundary.map(project),
      color: `rgb(${to255(cell.fraction)},${to255(cell.jitter)},${to255(cell.order)})`,
    });
  }
  return out;
}

/** Projection into region-logical px (0 at rect.min, scaleFor(zoom) px/world). */
function logicalProject(spec: RegionSpec): (p: WorldPoint) => WorldPoint {
  const scale = scaleFor(spec.zoom);
  const { minX, minY } = spec.rect;
  return ([x, y]) => [(x - minX) * scale, (y - minY) * scale];
}

/**
 * Ghost lattice: outlines of every not-fully-explored cell, region-logical px.
 * (A fully explored neighborhood draws no lattice — same as the old shader's
 * `!discovered` gate.)
 */
export function cellLatticePath(field: RegionCellField, spec: RegionSpec): string {
  const project = logicalProject(spec);
  return field.cells
    .filter((c) => c.fraction < 1)
    .map((c) => ring(c.boundary, project))
    .filter(Boolean)
    .join(' ');
}

/** Amber frontier rim: outlines of frontier cells (display res only). */
export function cellRimPath(field: RegionCellField, spec: RegionSpec): string {
  const project = logicalProject(spec);
  return field.cells
    .filter((c) => c.frontier)
    .map((c) => ring(c.boundary, project))
    .filter(Boolean)
    .join(' ');
}

/** A closed SVG ring for one cell boundary. */
function ring(boundary: readonly WorldPoint[], project: (p: WorldPoint) => WorldPoint): string {
  const line = polyline(boundary, project);
  return line ? `${line}Z` : '';
}

/** An SVG "M…L…" open polyline over projected world points (hex-cell boundaries). */
function polyline(points: readonly WorldPoint[], project: (p: WorldPoint) => WorldPoint): string {
  if (points.length < 2) return '';
  let out = '';
  for (let i = 0; i < points.length; i++) {
    const [x, y] = project(points[i]);
    out += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return out;
}
