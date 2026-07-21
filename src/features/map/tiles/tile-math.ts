import type { WorldRect } from '../core/types';

/** XYZ tile address. */
export interface TileCoord {
  readonly z: number;
  readonly x: number;
  readonly y: number;
}

export type TileKey = string; // "z/x/y"

/** The whole [0,1]² world. */
export const WORLD_RECT: WorldRect = { minX: 0, minY: 0, maxX: 1, maxY: 1 };

/**
 * The contiguous zoom range a tileset carries real data at. The planet bake
 * covers z0–14; the bundled fixture covers z12–14. Camera zooms outside the
 * range overzoom (reuse the nearest baked vectors at a larger transform).
 */
export interface DataZoomRange {
  readonly min: number;
  readonly max: number;
}

export function tileKeyOf(z: number, x: number, y: number): TileKey {
  return z + '/' + x + '/' + y;
}

/**
 * How many zoom levels coarser than the display tile zoom to actually fetch
 * geometry at. Overzooming the vector data (rendering z13 streets at a z15 view)
 * cuts tile count ~4× and mask-rasterization cost ~2.5× — the dot field abstracts
 * streets into a lattice anyway, so the lost fine detail doesn't read. This is the
 * map's main level-of-detail lever.
 */
export const DATA_ZOOM_BIAS = 1;

/** The (overzoomed) tile zoom to fetch geometry at, clamped to what the tileset carries. */
export function dataZoomFor(cameraZoom: number, range: DataZoomRange): number {
  const tileZoom = Math.max(range.min, Math.min(range.max, Math.floor(cameraZoom)));
  return Math.max(range.min, tileZoom - DATA_ZOOM_BIAS);
}

/** World rect covered by a tile ([0,1]² world space, y south). */
export function tileWorldRect({ z, x, y }: TileCoord): WorldRect {
  const span = 1 / Math.pow(2, z);
  return { minX: x * span, minY: y * span, maxX: (x + 1) * span, maxY: (y + 1) * span };
}

/** All tiles at `z` intersecting `rect`, clamped to the world. */
export function tilesCovering(rect: WorldRect, z: number): TileCoord[] {
  const n = Math.pow(2, z);
  const clampIdx = (v: number) => Math.max(0, Math.min(n - 1, v));
  const x0 = clampIdx(Math.floor(rect.minX * n));
  const x1 = clampIdx(Math.floor(rect.maxX * n));
  const y0 = clampIdx(Math.floor(rect.minY * n));
  const y1 = clampIdx(Math.floor(rect.maxY * n));
  const tiles: TileCoord[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      tiles.push({ z, x, y });
    }
  }
  return tiles;
}
