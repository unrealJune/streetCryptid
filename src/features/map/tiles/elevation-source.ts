import type { RegionSpec } from '../core/region';
import type { ElevationRaster } from '../core/terrain';
import type { TileByteSource, TilePayload } from './tile-bytes';
import { tileKeyOf, tilesCovering, type TileCoord, type TileKey } from './tile-math';

/**
 * Elevation for a region's mask pixels, from Mapbox terrain-RGB raster tiles
 * (WebP/PNG) served beside the vector tileset at `{base}/terrain`.
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

/** The DEM zoom whose pixels best match `spec`'s mask pixels. */
export function terrainZoomFor(spec: RegionSpec): number {
  const z = Math.round(spec.zoom + MASK_ZOOM_OFFSET);
  return Math.max(0, Math.min(TERRAIN_MAX_ZOOM, z));
}

/** Mapbox terrain-RGB: metres = -10000 + (R·65536 + G·256 + B) · 0.1. */
export function decodeTerrainRgb(image: DecodedImage): Float32Array {
  const { width, height, rgba } = image;
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) {
    out[i] = -10000 + (rgba[i * 4] * 65536 + rgba[i * 4 + 1] * 256 + rgba[i * 4 + 2]) * 0.1;
  }
  return out;
}

interface DemTile {
  readonly size: number;
  readonly metres: Float32Array;
}

export class TerrainRgbElevationSource implements ElevationSource {
  private readonly decoded = new Map<TileKey, DemTile | null>();

  constructor(
    private readonly bytes: TileByteSource,
    private readonly decodeImage: ImageDecoder
  ) {}

  async elevationFor(spec: RegionSpec): Promise<ElevationRaster | null> {
    const z = terrainZoomFor(spec);
    const tiles = tilesCovering(spec.rect, z);
    const dem = new Map<TileKey, DemTile | null>();
    await Promise.all(
      tiles.map(async (t) => {
        dem.set(tileKeyOf(t.z, t.x, t.y), await this.tile(t));
      })
    );
    if (![...dem.values()].some(Boolean)) return null;
    return sampleRaster(spec, z, dem);
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
  return { size: image.width, metres: decodeTerrainRgb(image) };
}

/**
 * Bilinear elevation at every mask pixel centre. A pixel over a tile the DEM
 * does not carry (open ocean) reads 0 m.
 */
export function sampleRaster(
  spec: RegionSpec,
  z: number,
  dem: ReadonlyMap<TileKey, DemTile | null>
): ElevationRaster {
  const { maskWidth: width, maskHeight: height, rect } = spec;
  const n = 2 ** z;
  const size = [...dem.values()].find(Boolean)?.size ?? 256;
  const spanX = rect.maxX - rect.minX;
  const spanY = rect.maxY - rect.minY;

  // Clamp into the fetched tiles: the bilinear neighbour of an edge pixel can
  // fall one tile outside `tilesCovering`, which would read as sea level and
  // draw a false cliff along the region border.
  const minG = Math.floor(rect.minX * n) * size;
  const maxGX = (Math.floor(rect.maxX * n) + 1) * size - 1;
  const minGY = Math.floor(rect.minY * n) * size;
  const maxGY = (Math.floor(rect.maxY * n) + 1) * size - 1;
  const at = (rawX: number, rawY: number): number => {
    const gx = Math.min(maxGX, Math.max(minG, rawX));
    const gy = Math.min(maxGY, Math.max(minGY, rawY));
    const tx = Math.floor(gx / size);
    const ty = Math.floor(gy / size);
    const tile = dem.get(tileKeyOf(z, tx, ty));
    if (!tile) return 0;
    const px = Math.min(size - 1, Math.max(0, gx - tx * size));
    const py = Math.min(size - 1, Math.max(0, gy - ty * size));
    return tile.metres[py * size + px];
  };

  const metres = new Float32Array(width * height);
  for (let j = 0; j < height; j++) {
    const gy = (rect.minY + ((j + 0.5) / height) * spanY) * n * size - 0.5;
    const iy = Math.floor(gy);
    const fy = gy - iy;
    for (let i = 0; i < width; i++) {
      const gx = (rect.minX + ((i + 0.5) / width) * spanX) * n * size - 0.5;
      const ix = Math.floor(gx);
      const fx = gx - ix;
      metres[j * width + i] =
        (at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx) * (1 - fy) +
        (at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx) * fy;
    }
  }
  return { width, height, metres };
}
