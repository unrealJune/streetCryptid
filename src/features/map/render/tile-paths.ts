import { FillType, Skia, type SkCanvas, type SkPath } from '@shopify/react-native-skia';

import { AERO_AREA_KINDS, AERO_LINE_KINDS, GROUND_KINDS, TRANSIT_MODES } from '../core/types';
import type { PackedTile } from '../tiles/packed-geometry';
import { areasSvg, buildingBinSvgs, linesSvg, TILE_PATH_UNITS } from './tile-path-svg';

export { TILE_PATH_UNITS } from './tile-path-svg';

/**
 * Skia paths for one decoded tile, built ONCE per tile and drawn into every
 * region that covers it through a canvas transform.
 *
 * Every region build used to project the whole region's geometry into its own
 * pixel space, write it out as SVG text in JS, and have Skia parse that text
 * back — per layer, per preview stage, per relief upgrade, per region. Profiled
 * on the web build, `MakeFromSVGString` alone was 43% of all region render time
 * and the string building another few seconds; on device the string building is
 * exactly the kind of work Hermes is slowest at. Tile geometry never changes, so
 * none of that has to be repeated: a tile's paths live as long as the tile does
 * (weakly keyed on the decoded tile) and a region only issues draw calls.
 * The text itself is `tile-path-svg.ts`.
 */

/** A layer of one tile, built lazily on first draw. */
type Layer =
  | `street:${number}`
  | 'park'
  | 'water'
  | 'rivers'
  | `ground:${number}`
  | `transit:${number}`
  | `aeroArea:${number}`
  | `aeroLine:${number}`;

/** Buildings by the zoom at which they first earn an outline (`BUILDING_MIN_PX`). */
export interface BuildingBin {
  readonly minZoom: number;
  readonly path: SkPath;
}

interface TileCache {
  readonly layers: Map<Layer, SkPath | null>;
  buildings?: readonly BuildingBin[];
}

const cache = new WeakMap<PackedTile, TileCache>();

function entry(tile: PackedTile): TileCache {
  let found = cache.get(tile);
  if (!found) {
    found = { layers: new Map() };
    cache.set(tile, found);
  }
  return found;
}

function layerPath(tile: PackedTile, layer: Layer, build: () => string): SkPath | null {
  const { layers } = entry(tile);
  if (layers.has(layer)) return layers.get(layer)!;
  const svg = build();
  // Non-zero winding unions overlapping fills (see `mask-image.ts`), and a path parsed from SVG is
  // already non-zero. Paths are immutable since Skia 2.14; copying every tile layer through a
  // builder to restate the default would be pure cost.
  const path = svg ? Skia.Path.MakeFromSVGString(svg) : null;
  layers.set(layer, path);
  return path;
}

export function streetPath(tile: PackedTile, roadClass: number): SkPath | null {
  const s = tile.streets;
  return layerPath(tile, `street:${roadClass}`, () =>
    linesSvg(s, (i) => s.roadClass[i] === roadClass)
  );
}

export const parkPath = (tile: PackedTile) => layerPath(tile, 'park', () => areasSvg(tile.parks));
export const waterPath = (tile: PackedTile) => layerPath(tile, 'water', () => areasSvg(tile.water));
export const riverPath = (tile: PackedTile) =>
  layerPath(tile, 'rivers', () => linesSvg(tile.rivers));

export function groundPath(tile: PackedTile, kindIndex: number): SkPath | null {
  const g = tile.groundCover;
  if (g.count === 0 || kindIndex >= GROUND_KINDS.length) return null;
  return layerPath(tile, `ground:${kindIndex}`, () => areasSvg(g, (i) => g.kind[i] === kindIndex));
}

export function transitPath(tile: PackedTile, modeIndex: number): SkPath | null {
  const t = tile.transit;
  if (t.count === 0 || modeIndex >= TRANSIT_MODES.length) return null;
  return layerPath(tile, `transit:${modeIndex}`, () => linesSvg(t, (i) => t.mode[i] === modeIndex));
}

export function aeroAreaPath(tile: PackedTile, kindIndex: number): SkPath | null {
  const a = tile.aeroAreas;
  if (a.count === 0 || kindIndex >= AERO_AREA_KINDS.length) return null;
  return layerPath(tile, `aeroArea:${kindIndex}`, () =>
    areasSvg(a, (i) => a.kind[i] === kindIndex)
  );
}

export function aeroLinePath(tile: PackedTile, kindIndex: number): SkPath | null {
  const a = tile.aeroLines;
  if (a.count === 0 || kindIndex >= AERO_LINE_KINDS.length) return null;
  return layerPath(tile, `aeroLine:${kindIndex}`, () =>
    linesSvg(a, (i) => a.kind[i] === kindIndex)
  );
}

/** A tile's buildings, binned by the zoom at which each becomes big enough to draw. */
export function buildingBins(tile: PackedTile): readonly BuildingBin[] {
  const e = entry(tile);
  if (!e.buildings) {
    e.buildings = buildingBinSvgs(tile.buildings).flatMap(({ minZoom, svg }) => {
      const path = Skia.Path.MakeFromSVGString(svg);
      // Non-zero already: see `layerPath`.
      return path ? [{ minZoom, path }] : [];
    });
  }
  return e.buildings;
}

/**
 * Draw tile paths into a canvas whose units are `scale` per world unit, with
 * world point `origin` at canvas (0, 0). `draw` is called once per tile under
 * that tile's transform, with `k`: canvas units per tile-path unit. Anything
 * drawn in canvas units (a stroke width, a dash interval) must be divided by
 * `k`, because the transform scales it too.
 */
export function drawTileLayers(
  canvas: SkCanvas,
  tiles: readonly PackedTile[],
  origin: readonly [number, number],
  scale: number,
  draw: (tile: PackedTile, k: number) => void
): void {
  const k = scale / TILE_PATH_UNITS;
  for (const tile of tiles) {
    canvas.save();
    canvas.translate((tile.originX - origin[0]) * scale, (tile.originY - origin[1]) * scale);
    canvas.scale(k, k);
    draw(tile, k);
    canvas.restore();
  }
}

/**
 * One path in region canvas units assembled from tile paths, for drawing that
 * needs the whole region as a single path (a clip). Skia copies and transforms
 * the points natively; nothing is parsed.
 */
export function assembleRegionPath(
  tiles: readonly PackedTile[],
  origin: readonly [number, number],
  scale: number,
  pathsOf: (tile: PackedTile) => readonly (SkPath | null)[]
): SkPath | null {
  const k = scale / TILE_PATH_UNITS;
  const out = Skia.PathBuilder.Make().setFillType(FillType.Winding);
  let any = false;
  for (const tile of tiles) {
    const paths = pathsOf(tile);
    if (!paths.some(Boolean)) continue;
    const m = Skia.Matrix([
      k,
      0,
      (tile.originX - origin[0]) * scale,
      0,
      k,
      (tile.originY - origin[1]) * scale,
      0,
      0,
      1,
    ]);
    for (const path of paths) {
      if (!path) continue;
      out.addPath(path, m);
      any = true;
    }
  }
  return any ? out.detach() : null;
}
