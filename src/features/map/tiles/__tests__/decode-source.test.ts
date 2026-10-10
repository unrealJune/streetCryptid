import { gzipSync } from 'fflate';
import type { FeatureCollection } from 'geojson';
import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';

import { DecodingGeometrySource, inflateTilePart, jsTileDecoder } from '../decode-source';
import { EMPTY_GEOMETRY } from '../geometry-source';
import type { TileByteSource } from '../tile-bytes';
import type { TileCoord } from '../tile-math';

const TILE: TileCoord = { z: 14, x: 2624, y: 5722 };

function sourceOf(bytes: Uint8Array | readonly Uint8Array[] | null): TileByteSource {
  return { getTileBytes: async () => bytes };
}

/** A real MVT buffer with one place point, built the same way as mvt-mapping tests. */
function placeTileBytes(name = 'Testville', layer = 'place'): Uint8Array {
  const fc: FeatureCollection = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { name, class: 'city', rank: 1 },
        geometry: { type: 'Point', coordinates: [-122.332, 47.597] },
      },
    ],
  };
  const idx = geojsonvt(fc, { maxZoom: TILE.z, indexMaxZoom: TILE.z, indexMaxPoints: 0 });
  const tile = idx.getTile(TILE.z, TILE.x, TILE.y);
  if (!tile) throw new Error('fixture point does not fall in TILE');
  return new Uint8Array(vtpbf.fromGeojsonVt({ [layer]: tile }, { version: 2 }));
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

  it('inflates a single gzip member', async () => {
    const source = new DecodingGeometrySource(sourceOf(gzipSync(placeTileBytes(), { mtime: 0 })));
    const geometry = await source.getTile(TILE);
    expect(geometry.places.map((p) => p.name)).toEqual(['Testville']);
  });

  it('decodes the layers of every part, gzip or raw, as one tile', async () => {
    const structure = gzipSync(placeTileBytes('Structureville'), { mtime: 0 });
    const labels = gzipSync(placeTileBytes('Labelton', 'poi'), { mtime: 0 });
    const source = new DecodingGeometrySource(sourceOf([structure, labels]));
    const geometry = await source.getTile(TILE);
    expect(geometry.places.map((p) => p.name)).toEqual(['Structureville']);
    expect(geometry.parts.flatMap((t) => t.pois.map((p) => p.name))).toEqual(['Labelton']);

    const raw = await jsTileDecoder(
      [placeTileBytes('Structureville'), placeTileBytes('Labelton', 'poi')],
      TILE
    );
    expect(raw.places.map((p) => p.name)).toEqual(['Structureville']);
    expect(raw.parts.flatMap((t) => t.pois.map((p) => p.name))).toEqual(['Labelton']);
  });

  it('refuses a part that inflates past its bound', () => {
    const member = gzipSync(new Uint8Array(16), { mtime: 0 });
    new DataView(member.buffer).setUint32(member.length - 4, 16 * 1024 * 1024 + 1, true);
    expect(() => inflateTilePart(member)).toThrow('bound');
  });

  it('propagates upstream failure', async () => {
    const source = new DecodingGeometrySource({
      getTileBytes: () => Promise.reject(new Error('network down')),
    });
    await expect(source.getTile(TILE)).rejects.toThrow('network down');
  });
});
