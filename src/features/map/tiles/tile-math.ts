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

/**
 * Camera zoom at and above which the overzoom bias is dropped, so geometry is
 * fetched at the tileset's finest level instead of one coarser.
 *
 * This exists for LABELS, not for streets. OpenMapTiles puts POI names — the
 * only source of a building label, since the `building` layer carries footprints
 * and heights but no name — in a `poi` layer that is rank-filtered to a handful
 * of landmarks at z13 and only becomes dense at z14 (measured on our own bake:
 * 15 features vs 2354 in the same Capitol Hill tile). `housenumber` is z14-only
 * outright.
 *
 * It is not free: because the privacy anchor is fixed at z10, a cold z14 request
 * pulls the whole 16×16 descendant square — 256 tiles, ~22 MiB, against ~3.3 MiB
 * for the 64-tile z13 bundle (infra/tiles/PLAN.md). That is one fetch per z10
 * cell, then cached in SQLite for the tile TTL, and it is only ever paid by
 * someone who zooms all the way in — which is why the threshold sits well past
 * the everyday street zoom rather than at the z14 data edge.
 */
export const DATA_ZOOM_FULL_DETAIL_ZOOM = 16;

/** The (overzoomed) tile zoom to fetch geometry at, clamped to what the tileset carries. */
export function dataZoomFor(cameraZoom: number, range: DataZoomRange): number {
  const tileZoom = Math.max(range.min, Math.min(range.max, Math.floor(cameraZoom)));
  const bias = cameraZoom >= DATA_ZOOM_FULL_DETAIL_ZOOM ? 0 : DATA_ZOOM_BIAS;
  return Math.max(range.min, tileZoom - bias);
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
