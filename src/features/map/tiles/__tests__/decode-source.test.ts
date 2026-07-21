import type { FeatureCollection } from 'geojson';
import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';

import { DecodingGeometrySource } from '../decode-source';
import { EMPTY_GEOMETRY } from '../geometry-source';
import type { TileByteSource } from '../tile-bytes';
import type { TileCoord } from '../tile-math';

const TILE: TileCoord = { z: 14, x: 2624, y: 5722 };

function sourceOf(bytes: Uint8Array | null): TileByteSource {
  return { getTileBytes: async () => bytes };
}

/** A real MVT buffer with one place point, built the same way as mvt-mapping tests. */
function placeTileBytes(): Uint8Array {
  const fc: FeatureCollection = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { name: 'Testville', class: 'city', rank: 1 },
        geometry: { type: 'Point', coordinates: [-122.332, 47.597] },
      },
    ],
  };
  const idx = geojsonvt(fc, { maxZoom: TILE.z, indexMaxZoom: TILE.z, indexMaxPoints: 0 });
  const tile = idx.getTile(TILE.z, TILE.x, TILE.y);
  if (!tile) throw new Error('fixture point does not fall in TILE');
  return new Uint8Array(vtpbf.fromGeojsonVt({ place: tile }, { version: 2 }));
}

describe('DecodingGeometrySource', () => {
  it('null bytes decode to empty geometry', async () => {
    const source = new DecodingGeometrySource(sourceOf(null));
    expect(await source.getTile(TILE)).toBe(EMPTY_GEOMETRY);
  });

  it('zero-length bytes decode to empty geometry', async () => {
    const source = new DecodingGeometrySource(sourceOf(new Uint8Array(0)));
    expect(await source.getTile(TILE)).toBe(EMPTY_GEOMETRY);
  });

  it('real MVT bytes decode through decodeMvtTile', async () => {
    const source = new DecodingGeometrySource(sourceOf(placeTileBytes()));
    const geometry = await source.getTile(TILE);
    expect(geometry.places.map((p) => p.name)).toEqual(['Testville']);
  });

  it('propagates upstream failure', async () => {
    const source = new DecodingGeometrySource({
      getTileBytes: () => Promise.reject(new Error('network down')),
    });
    await expect(source.getTile(TILE)).rejects.toThrow('network down');
  });
});
