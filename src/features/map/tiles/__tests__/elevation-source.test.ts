import type { RegionSpec } from '../../core/region';
import {
  decodeTerrainRgb,
  TERRAIN_MAX_ZOOM,
  TerrainRgbElevationSource,
  terrainZoomFor,
  type DecodedImage,
} from '../elevation-source';
import type { TileByteSource } from '../tile-bytes';
import { tileWorldRect, type TileCoord } from '../tile-math';

/** Terrain-RGB pixel for an elevation in metres. */
function rgbFor(metres: number): [number, number, number] {
  const v = Math.round((metres + 10000) * 10);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
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

describe('decodeTerrainRgb', () => {
  it('decodes Mapbox terrain-RGB to metres at 0.1 m', () => {
    const decoded = decodeTerrainRgb(image(2, (x, y) => [-12.5, 0, 924.3, 8848][y * 2 + x]));
    expect(Array.from(decoded).map((v) => Math.round(v * 10) / 10)).toEqual([
      -12.5, 0, 924.3, 8848,
    ]);
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

describe('TerrainRgbElevationSource', () => {
  // The fake decoder passes the image straight through as the tile's one part.
  const encoded = (img: DecodedImage) => [img as unknown as Uint8Array];
  const decode = (bytes: Uint8Array) => bytes as unknown as DecodedImage;

  it('samples the covering tiles bilinearly at mask pixel centres', async () => {
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
    const raster = (await new TerrainRgbElevationSource(bytes, decode).elevationFor(spec))!;
    expect(requested).toEqual([tile]);
    expect(raster.width).toBe(16);
    // Mask pixel i covers DEM px 16i..16i+16; its centre is DEM px 16i + 7.5.
    expect(raster.metres[0]).toBeCloseTo(75, 1);
    expect(raster.metres[15]).toBeCloseTo((16 * 15 + 7.5) * 10, 1);
    expect(raster.metres[16 * 8 + 3]).toBeCloseTo(raster.metres[3], 3); // no north-south slope
  });

  it('returns null where no terrain tile exists (open sea, or no terrain server)', async () => {
    const source = new TerrainRgbElevationSource({ getTileBytes: async () => null }, decode);
    expect(await source.elevationFor(specOver({ z: 10, x: 1, y: 1 }, 11.3))).toBeNull();
  });

  it('decodes each tile once across regions', async () => {
    const tile = { z: 10, x: 5, y: 5 };
    let fetches = 0;
    const decoder = jest.fn(decode);
    const source = new TerrainRgbElevationSource(
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
});
