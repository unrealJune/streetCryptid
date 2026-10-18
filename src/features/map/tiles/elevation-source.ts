import type { RegionSpec } from '../core/region';
import type { ElevationRaster } from '../core/terrain';
import type { WorldRect } from '../core/types';
import type { TileByteSource, TilePayload } from './tile-bytes';
import { tileKeyOf, tilesCovering, type TileCoord, type TileKey } from './tile-math';

/**
 * Elevation for a region's mask pixels, from Terrarium-encoded raster tiles
 * (WebP/PNG) served beside the vector tileset at `{base}/terrain` — the map
 * server's bake of the Copernicus GLO-30 DEM, in integer metres.
 *
 * The tiles travel through the same privacy machinery as the vector ones: the
 * byte source is a `BundleFetchByteSource`, so z11–12 requests leave the app only
 * as the complete z10-anchored bundle and repeat visits are answered from SQLite.
 *
 * Pure apart from the injected image decoder (Skia on device and web, a fake in
 * tests), so the zoom choice and the sampling are unit-tested headlessly.
 */
export interface ElevationSource {
  /** Elevation at every mask pixel of `spec`, or null when no tile covers it. */
  elevationFor(spec: RegionSpec): Promise<ElevationRaster | null>;
}

/** Decoded RGBA pixels of one raster tile (row-major, 4 bytes per pixel). */
export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

export type ImageDecoder = (bytes: Uint8Array) => DecodedImage | null;

/** The DEM's finest zoom: GLO-30 is ~30 m, and a z12 pixel is ~38 m at the equator. */
export const TERRAIN_MAX_ZOOM = 12;

/**
 * log2 of the mask's px per region-logical px (`computeRegionSpec`'s default
 * `maskScale` of 0.4), so a DEM pixel lands on about one mask pixel.
 */
const MASK_ZOOM_OFFSET = Math.log2(0.4);

/** Decoded tiles kept in memory: a region at z12 touches ~15, neighbours share most. */
const DECODED_CAPACITY = 64;

/** Region rasters kept for identity reuse — about the render cache's depth plus neighbours. */
const RASTER_CAPACITY = 8;

/** The DEM zoom whose pixels best match `spec`'s mask pixels. */
export function terrainZoomFor(spec: RegionSpec): number {
  const z = Math.round(spec.zoom + MASK_ZOOM_OFFSET);
  return Math.max(0, Math.min(TERRAIN_MAX_ZOOM, z));
}

/** Terrarium: metres = R·256 + G + B/256 − 32768. */
export function decodeTerrarium(image: DecodedImage): Float32Array {
  const { width, height, rgba } = image;
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) {
    out[i] = rgba[i * 4] * 256 + rgba[i * 4 + 1] + rgba[i * 4 + 2] / 256 - 32768;
  }
  return out;
}

/** One decoded DEM tile, kept as Terrarium RGBA: metres are decoded only for the pixels a region reads. */
export interface DemTile {
  readonly size: number;
  readonly rgba: Uint8Array;
}

export class TerrariumElevationSource implements ElevationSource {
  private readonly decoded = new Map<TileKey, DemTile | null>();
  /**
   * The rasters of the last few regions, by rect and DEM zoom. A raster is a
   * render-cache key (`render-bundle-cache.ts` compares it by identity), so
   * returning to a region must hand back the SAME raster or its bitmap is drawn
   * again for nothing.
   */
  private readonly rasters = new Map<string, Promise<ElevationRaster | null>>();

  constructor(
    private readonly bytes: TileByteSource,
    private readonly decodeImage: ImageDecoder
  ) {}

  elevationFor(spec: RegionSpec): Promise<ElevationRaster | null> {
    const z = terrainZoomFor(spec);
    const { minX, minY, maxX, maxY } = spec.rect;
    const key = `${z}|${minX},${minY},${maxX},${maxY}`;
    let raster = this.rasters.get(key);
    if (raster) {
      this.rasters.delete(key);
    } else {
      raster = this.build(spec, z);
      // A failure is not remembered: the next region asks the network again.
      raster.catch(() => this.rasters.delete(key));
    }
    this.rasters.set(key, raster);
    if (this.rasters.size > RASTER_CAPACITY) {
      this.rasters.delete(this.rasters.keys().next().value!);
    }
    return raster;
  }

  private async build(spec: RegionSpec, z: number): Promise<ElevationRaster | null> {
    const tiles = tilesCovering(spec.rect, z);
    const dem = new Map<TileKey, DemTile | null>();
    await Promise.all(
      tiles.map(async (t) => {
        dem.set(tileKeyOf(t.z, t.x, t.y), await this.tile(t));
      })
    );
    if (![...dem.values()].some(Boolean)) return null;
    return cropRaster(spec.rect, z, dem);
  }

  private async tile(t: TileCoord): Promise<DemTile | null> {
    const key = tileKeyOf(t.z, t.x, t.y);
    if (this.decoded.has(key)) {
      const hit = this.decoded.get(key) ?? null;
      // Refresh recency.
      this.decoded.delete(key);
      this.decoded.set(key, hit);
      return hit;
    }
    const payload = await this.bytes.getTileBytes(t);
    const tile = decodeTile(payload, this.decodeImage);
    this.decoded.set(key, tile);
    if (this.decoded.size > DECODED_CAPACITY) {
      const oldest = this.decoded.keys().next().value;
      if (oldest !== undefined) this.decoded.delete(oldest);
    }
    return tile;
  }
}

function decodeTile(payload: TilePayload | null, decodeImage: ImageDecoder): DemTile | null {
  const bytes = payload instanceof Uint8Array ? payload : payload?.[0];
  if (!bytes || bytes.byteLength === 0) return null;
  const image = decodeImage(bytes);
  if (!image || image.width !== image.height || image.width === 0) return null;
  return { size: image.width, rgba: image.rgba };
}

/**
 * The DEM pixels under `rect` at native resolution, in metres — every pixel
 * whose centre a bilinear sample anywhere in `rect` can reach. A pixel over a
 * tile the DEM does not carry (open ocean) reads 0 m.
 *
 * Deliberately NOT resampled to the mask: the render layer stretches this grid
 * over the mask with the GPU's bilinear filter. Sampling every mask pixel in JS
 * (four string-keyed tile lookups each) cost 1.3–2.5 s of Hermes-class
 * interpreter time per region build on a 470×1020 mask, which blocked the JS
 * thread exactly while the map was trying to draw. The crop is proportional to
 * the DEM, which at street zoom is a few thousand pixels.
 */
export function cropRaster(
  rect: WorldRect,
  z: number,
  dem: ReadonlyMap<TileKey, DemTile | null>
): ElevationRaster {
  const n = 2 ** z;
  const size = [...dem.values()].find(Boolean)?.size ?? 256;
  const world = n * size; // DEM px per world unit

  // Clamp into the fetched tiles: the bilinear neighbour of an edge pixel can
  // fall one tile outside `tilesCovering`, which would read as sea level and
  // draw a false cliff along the region border.
  const x0 = Math.max(Math.floor(rect.minX * n) * size, Math.floor(rect.minX * world - 0.5));
  const y0 = Math.max(Math.floor(rect.minY * n) * size, Math.floor(rect.minY * world - 0.5));
  const x1 = Math.min(
    (Math.floor(rect.maxX * n) + 1) * size - 1,
    Math.floor(rect.maxX * world - 0.5) + 1
  );
  const y1 = Math.min(
    (Math.floor(rect.maxY * n) + 1) * size - 1,
    Math.floor(rect.maxY * world - 0.5) + 1
  );
  const width = Math.max(1, x1 - x0 + 1);
  const height = Math.max(1, y1 - y0 + 1);

  const metres = new Float32Array(width * height);
  for (let gy = y0; gy < y0 + height; gy++) {
    const ty = Math.floor(gy / size);
    const row = (gy - ty * size) * size;
    const out = (gy - y0) * width;
    // One tile lookup per tile column per row, never per pixel.
    for (let gx = x0; gx < x0 + width;) {
      const tx = Math.floor(gx / size);
      const end = Math.min(x0 + width, (tx + 1) * size);
      const rgba = dem.get(tileKeyOf(z, tx, ty))?.rgba;
      if (rgba) {
        for (let p = (row + gx - tx * size) * 4, o = out + gx - x0; gx < end; gx++, p += 4, o++) {
          metres[o] = rgba[p] * 256 + rgba[p + 1] + rgba[p + 2] / 256 - 32768;
        }
      }
      gx = end;
    }
  }
  return {
    width,
    height,
    metres,
    rect: {
      minX: x0 / world,
      minY: y0 / world,
      maxX: (x0 + width) / world,
      maxY: (y0 + height) / world,
    },
  };
}
