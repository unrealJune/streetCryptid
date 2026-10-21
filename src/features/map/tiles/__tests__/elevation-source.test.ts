import type { RegionSpec } from '../../core/region';
import { rasterMaskRect } from '../../core/terrain';
import {
  decodeTerrarium,
  TERRAIN_MAX_ZOOM,
  TerrariumElevationSource,
  terrainZoomFor,
  type DecodedImage,
} from '../elevation-source';
import type { TileByteSource } from '../tile-bytes';
import { tileWorldRect, type TileCoord } from '../tile-math';

/** Terrarium pixel for an elevation in metres (1/256 m precision). */
function rgbFor(metres: number): [number, number, number] {
  const v = metres + 32768;
  const whole = Math.floor(v);
  return [(whole >> 8) & 255, whole & 255, Math.round((v - whole) * 256)];
}

/** A size×size image whose elevation is `f(px, py)`. */
function image(size: number, f: (px: number, py: number) => number): DecodedImage {
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const [r, g, b] = rgbFor(f(x, y));
      rgba.set([r, g, b, 255], (y * size + x) * 4);
    }
  return { width: size, height: size, rgba };
}

/** A region exactly over `tile`, pulled in a hair so `tilesCovering` keeps to it. */
function specOver(tile: TileCoord, zoom: number, mask = 32): RegionSpec {
  const r = tileWorldRect(tile);
  const e = (r.maxX - r.minX) * 1e-9;
  return {
    rect: { minX: r.minX, minY: r.minY, maxX: r.maxX - e, maxY: r.maxY - e },
    maskWidth: mask,
    maskHeight: mask,
    zoom,
    tileZoom: Math.min(14, Math.round(zoom) - 1),
    cellRes: null,
  };
}

describe('decodeTerrarium', () => {
  it('decodes Terrarium to metres, below sea level included', () => {
    const decoded = decodeTerrarium(image(2, (x, y) => [-12.5, 0, 924.25, 8848][y * 2 + x]));
    expect(Array.from(decoded)).toEqual([-12.5, 0, 924.25, 8848]);
  });
});

describe('terrainZoomFor', () => {
  it('matches DEM pixels to mask pixels and stops at the DEM resolution', () => {
    expect(terrainZoomFor(specOver({ z: 10, x: 0, y: 0 }, 11))).toBe(10);
    expect(terrainZoomFor(specOver({ z: 10, x: 0, y: 0 }, 9.5))).toBe(8);
    expect(terrainZoomFor(specOver({ z: 10, x: 0, y: 0 }, 17))).toBe(TERRAIN_MAX_ZOOM);
    expect(terrainZoomFor(specOver({ z: 0, x: 0, y: 0 }, 0.5))).toBe(0);
  });
});

describe('TerrariumElevationSource', () => {
  // The fake decoder passes the image straight through as the tile's one part.
  const encoded = (img: DecodedImage) => [img as unknown as Uint8Array];
  const decode = (bytes: Uint8Array) => bytes as unknown as DecodedImage;

  it('returns the covering tile at DEM resolution, placed on its own rect', async () => {
    // A slope rising east: 10 m per DEM pixel across one z10 tile.
    const tile = { z: 10, x: 900, y: 400 };
    const spec = specOver(tile, 11.3, 16); // DEM zoom 10 → exactly this tile
    const requested: TileCoord[] = [];
    const bytes: TileByteSource = {
      async getTileBytes(t) {
        requested.push(t);
        return t.x === tile.x && t.y === tile.y ? encoded(image(256, (x) => x * 10)) : null;
      },
    };
    const raster = (await new TerrariumElevationSource(bytes, decode).elevationFor(spec))!;
    expect(requested).toEqual([tile]);
    // Not resampled to the 16 px mask: the GPU's bilinear filter does that.
    expect([raster.width, raster.height]).toEqual([256, 256]);
    expect(raster.rect).toEqual(tileWorldRect(tile));
    expect(raster.metres[0]).toBe(0);
    expect(raster.metres[255]).toBe(2550);
    expect(raster.metres[256 * 100 + 7]).toBe(70); // no north-south slope
    const onMask = rasterMaskRect(raster, spec);
    expect(onMask.x).toBeCloseTo(0, 6);
    expect(onMask.width).toBeCloseTo(16, 4);
  });

  it('crops to the pixels a bilinear sample can reach, stitched across tiles', async () => {
    // Two z12 tiles side by side; the east one is missing (open sea).
    const west = { z: 12, x: 100, y: 100 };
    const r = tileWorldRect(west);
    const px = (r.maxX - r.minX) / 4; // one DEM pixel of a 4 px tile
    const spec: RegionSpec = {
      // From the middle of west pixel 1 to the middle of east pixel 0.
      rect: {
        minX: r.minX + 1.5 * px,
        minY: r.minY + 1.5 * px,
        maxX: r.maxX + 0.5 * px,
        maxY: r.minY + 2.5 * px,
      },
      maskWidth: 8,
      maskHeight: 4,
      zoom: 13.3, // DEM zoom 12
      tileZoom: 13,
      cellRes: null,
    };
    const source = new TerrariumElevationSource(
      {
        async getTileBytes(t) {
          return t.x === west.x ? encoded(image(4, (x, y) => 100 * y + x)) : null;
        },
      },
      decode
    );
    const raster = (await source.elevationFor(spec))!;
    // Columns west 1..3 + east 0..1, rows 1..3.
    expect([raster.width, raster.height]).toEqual([5, 3]);
    expect(raster.rect.minX).toBeCloseTo(r.minX + px, 12);
    expect(raster.rect.maxX).toBeCloseTo(r.maxX + 2 * px, 12);
    expect(Array.from(raster.metres.slice(0, 5))).toEqual([101, 102, 103, 0, 0]);
    expect(Array.from(raster.metres.slice(10, 15))).toEqual([301, 302, 303, 0, 0]);
  });

  it('returns null where no terrain tile exists (open sea, or no terrain server)', async () => {
    const source = new TerrariumElevationSource({ getTileBytes: async () => null }, decode);
    expect(await source.elevationFor(specOver({ z: 10, x: 1, y: 1 }, 11.3))).toBeNull();
  });

  it('decodes each tile once across regions', async () => {
    const tile = { z: 10, x: 5, y: 5 };
    let fetches = 0;
    const decoder = jest.fn(decode);
    const source = new TerrariumElevationSource(
      {
        async getTileBytes() {
          fetches++;
          return encoded(image(4, () => 100));
        },
      },
      decoder
    );
    await source.elevationFor(specOver(tile, 11.3, 8));
    await source.elevationFor(specOver(tile, 11.3, 8));
    expect(fetches).toBe(1);
    expect(decoder).toHaveBeenCalledTimes(1);
  });

  it('hands a region back the same raster, and forgets failures', async () => {
    const tile = { z: 10, x: 7, y: 7 };
    let fail = true;
    const source = new TerrariumElevationSource(
      {
        async getTileBytes() {
          if (fail) throw new Error('offline');
          return encoded(image(4, () => 100));
        },
      },
      decode
    );
    const spec = specOver(tile, 11.3, 8);
    await expect(source.elevationFor(spec)).rejects.toThrow('offline');
    fail = false;
    const first = await source.elevationFor(spec);
    expect(first).not.toBeNull();
    // Identity, not equality: the render cache keys a bitmap on this object.
    expect(await source.elevationFor({ ...spec })).toBe(first);
  });
});
