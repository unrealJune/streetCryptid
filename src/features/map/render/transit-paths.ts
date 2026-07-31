import { scaleFor } from '../core/camera';
import type { RegionSpec } from '../core/region';
import { transitWidthFor } from '../core/transit-lod';
import { TRANSIT_MODES, type TransitMode, type WorldPoint } from '../core/types';
import type { PackedGeometry } from '../tiles/packed-geometry';

/**
 * Pure SVG-path builder for the transit layer (the `mask-paths.ts` /
 * `cell-overlay-paths.ts` pattern: no Skia, unit-testable, one parse per batch
 * on the render side).
 *
 * Unlike streets, transit does NOT bake into the feature mask: the dot field
 * quantizes everything it touches to the lattice, which turns a single rail
 * line into a broken dotted trail. Transit lines are stroked as vectors over
 * the finished region bitmap instead, in **region-logical px** (0 at rect.min,
 * `scaleFor(spec.zoom)` px per world unit) — the same space the ghost lattice
 * and frontier rim use.
 */

/** One SVG polyline batch per mode; modes with nothing to draw are omitted. */
export type TransitPaths = Partial<Record<TransitMode, string>>;

export function buildTransitPaths(geometry: PackedGeometry, spec: RegionSpec): TransitPaths {
  const scale = scaleFor(spec.zoom);
  const { minX, minY } = spec.rect;

  // Zoom LOD: skip building paths for modes that won't be stroked at all.
  const active = TRANSIT_MODES.map((mode) => transitWidthFor(mode, spec.zoom) !== null);
  const batches: string[][] = TRANSIT_MODES.map(() => []);

  for (const part of geometry.parts) {
    const { originX, originY } = part;
    const project = (x: number, y: number): WorldPoint => [
      (originX + x - minX) * scale,
      (originY + y - minY) * scale,
    ];

    const t = part.transit;
    for (let i = 0; i < t.count; i++) {
      const mode = t.mode[i];
      if (!active[mode]) continue;
      const line = polyline(t.coords, t.pointOff[i], t.pointOff[i + 1], project);
      if (line) batches[mode].push(line);
    }
  }

  const paths: TransitPaths = {};
  for (let i = 0; i < TRANSIT_MODES.length; i++) {
    if (batches[i].length) paths[TRANSIT_MODES[i]] = batches[i].join(' ');
  }
  return paths;
}

/** An SVG "M…L…" open polyline in region-logical px (1-decimal rounded). */
function polyline(
  coords: Float32Array,
  from: number,
  to: number,
  project: (x: number, y: number) => WorldPoint
): string {
  if (to - from < 2) return '';
  let out = '';
  for (let j = from; j < to; j++) {
    const [x, y] = project(coords[j * 2], coords[j * 2 + 1]);
    out += `${j === from ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return out;
}
