import { TILE_SIZE } from '../core/camera';
import { BUILDING_MIN_PX, BUILDING_MIN_ZOOM } from '../core/structure-lod';
import type { PackedAreas, PackedLines } from '../tiles/packed-geometry';

/**
 * SVG path text for one decoded tile, in tile-local units — the input to the
 * cached Skia paths in `tile-paths.ts`. Pure (no Skia), so it runs in tests and
 * host scripts.
 *
 * Paths are in tile-local units: the tile's own f32 coordinate deltas times
 * {@link TILE_PATH_UNITS}, rounded to integers. 2^30 per world unit puts one
 * unit at 1/16 of a logical pixel at the deepest camera zoom (z18), and a z14
 * tile spans 65536 of them. Only a low-zoom tile has large values, and it is
 * never drawn close enough for f32 rounding to show. {@link drawTileLayers}
 * supplies the transform.
 */
export const TILE_PATH_UNITS = 2 ** 30;

/**
 * One open polyline in tile-local units; '' when it has fewer than two points.
 * An absolute move, then integer RELATIVE line-tos (`l dx dy …`): consecutive
 * points are close, so the deltas are short, and integers format and parse
 * far faster than decimals — this runs once per point of every tile, in
 * Hermes on device.
 */
export function localPolyline(coords: Float32Array, from: number, to: number): string {
  if (to - from < 2) return '';
  let px = Math.round(coords[from * 2] * TILE_PATH_UNITS);
  let py = Math.round(coords[from * 2 + 1] * TILE_PATH_UNITS);
  let out = 'M' + px + ' ' + py + 'l';
  for (let j = from + 1; j < to; j++) {
    const x = Math.round(coords[j * 2] * TILE_PATH_UNITS);
    const y = Math.round(coords[j * 2 + 1] * TILE_PATH_UNITS);
    out += x - px + ' ' + (y - py) + ' ';
    px = x;
    py = y;
  }
  return out;
}

/** Every line feature (that `keep` accepts) as one batched SVG string. */
export function linesSvg(lines: PackedLines, keep?: (i: number) => boolean): string {
  const out: string[] = [];
  for (let i = 0; i < lines.count; i++) {
    if (keep && !keep(i)) continue;
    const line = localPolyline(lines.coords, lines.pointOff[i], lines.pointOff[i + 1]);
    if (line) out.push(line);
  }
  return out.join(' ');
}

/** Every ring of every area feature (that `keep` accepts), closed, in decoded order. */
export function areasSvg(areas: PackedAreas, keep?: (i: number) => boolean): string {
  const out: string[] = [];
  for (let i = 0; i < areas.count; i++) {
    if (keep && !keep(i)) continue;
    for (let r = areas.ringOff[i]; r < areas.ringOff[i + 1]; r++) {
      const line = localPolyline(areas.coords, areas.pointOff[r], areas.pointOff[r + 1]);
      if (line) out.push(line + 'Z');
    }
  }
  return out.join(' ');
}

/** Bin granularity: a building may appear up to this many zoom levels late. */
const BUILDING_BIN = 0.25;

/**
 * Buildings grouped by the zoom at which their longer side reaches
 * {@link BUILDING_MIN_PX} (the old per-region `spansMinPx` filter, decided once
 * per tile instead of once per build). A region draws every bin at or below
 * its zoom. Footprints with a degenerate outer ring are dropped, as before.
 */
export function buildingBinSvgs(b: PackedAreas): { minZoom: number; svg: string }[] {
  const bins = new Map<number, string[]>();
  for (let i = 0; i < b.count; i++) {
    const ring = b.ringOff[i];
    if (ring >= b.ringOff[i + 1]) continue;
    const from = b.pointOff[ring];
    const to = b.pointOff[ring + 1];
    if (to - from < 3) continue;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let j = from; j < to; j++) {
      const x = b.coords[j * 2];
      const y = b.coords[j * 2 + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const extent = Math.max(maxX - minX, maxY - minY);
    if (!(extent > 0)) continue;
    const appears = Math.log2(BUILDING_MIN_PX / (extent * TILE_SIZE));
    const minZoom = Math.max(BUILDING_MIN_ZOOM, Math.ceil(appears / BUILDING_BIN) * BUILDING_BIN);
    let bin = bins.get(minZoom);
    if (!bin) bins.set(minZoom, (bin = []));
    for (let r = ring; r < b.ringOff[i + 1]; r++) {
      const line = localPolyline(b.coords, b.pointOff[r], b.pointOff[r + 1]);
      if (line) bin.push(line + 'Z');
    }
  }
  return [...bins]
    .sort(([a], [z]) => a - z)
    .map(([minZoom, lines]) => ({ minZoom, svg: lines.join(' ') }));
}
