import type { WorldRect } from '../core/types';

/** XYZ tile address. */
export interface TileCoord {
  readonly z: number;
  readonly x: number;
  readonly y: number;
}

export type TileKey = string; // "z/x/y"

/**
 * Highest zoom the tileset carries real data at. OpenMapTiles/Planetiler bake up
 * to z14; deeper camera zooms overzoom (reuse z14 vectors at a larger transform).
 */
export const DATA_MAX_ZOOM = 14;
export const DATA_MIN_ZOOM = 12;

export function tileKeyOf(z: number, x: number, y: number): TileKey {
  return z + '/' + x + '/' + y;
}

/** The tile zoom to fetch for a continuous camera zoom. */
export function tileZoomFor(cameraZoom: number): number {
  return Math.max(DATA_MIN_ZOOM, Math.min(DATA_MAX_ZOOM, Math.floor(cameraZoom)));
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
export function dataZoomFor(cameraZoom: number): number {
  return Math.max(DATA_MIN_ZOOM, tileZoomFor(cameraZoom) - DATA_ZOOM_BIAS);
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
