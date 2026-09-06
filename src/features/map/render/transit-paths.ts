import { worldToScreen } from '../core/camera';
import { regionMaskCamera, type RegionSpec } from '../core/region';
import { transitWidthFor } from '../core/transit-lod';
import { TRANSIT_MODES, type TransitMode, type WorldPoint } from '../core/types';
import type { PackedGeometry } from '../tiles/packed-geometry';

/**
 * Pure SVG-path builder for the transit layer (the `mask-paths.ts` /
 * `cell-overlay-paths.ts` pattern: no Skia, unit-testable, one parse per batch
 * on the render side).
 *
 * Paths use the same mask-pixel coordinates as streets. A separate colored
 * coverage texture preserves mode tints while the dot field gives transit
 * the same weight, fog and reveal treatment as highways.
 */

/** One SVG polyline batch per mode; modes with nothing to draw are omitted. */
export type TransitPaths = Partial<Record<TransitMode, string>>;

export function buildTransitPaths(geometry: PackedGeometry, spec: RegionSpec): TransitPaths {
  const { camera, viewport } = regionMaskCamera(spec);

  // Zoom LOD: skip building paths for modes that won't be stroked at all.
  const active = TRANSIT_MODES.map((mode) => transitWidthFor(mode, spec.zoom) !== null);
  const batches: string[][] = TRANSIT_MODES.map(() => []);

  for (const part of geometry.parts) {
    const { originX, originY } = part;
    const project = (x: number, y: number): WorldPoint =>
      worldToScreen(camera, viewport, [originX + x, originY + y]);

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

/** An SVG "M…L…" open polyline in mask px (1-decimal rounded). */
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
