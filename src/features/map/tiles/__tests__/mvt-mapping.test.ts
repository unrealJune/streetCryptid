// geojson-vt / vt-pbf declarations live in types/vendor.d.ts.
import type { FeatureCollection, Feature, LineString, Polygon, Point } from 'geojson';
import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';

import { decodeMvtTile, roadClassOf } from '../mvt-mapping';
import { tileWorldRect } from '../tile-math';

// ─── roadClassOf ───────────────────────────────────────────────────────────────

describe('roadClassOf', () => {
  it.each([
    ['motorway', 4],
    ['trunk', 4],
    ['primary', 3],
    ['secondary', 2],
    ['tertiary', 2],
    ['minor', 1],
    ['busway', 1],
    ['service', 0],
    ['track', 0],
    ['path', 0],
    ['raceway', 0],
  ] as const)('%s → %d', (omtClass, expected) => {
    expect(roadClassOf(omtClass)).toBe(expected);
  });

  it.each([['rail'], ['ferry'], ['transit'], ['aerialway'], ['']])('%s → null', (omtClass) => {
    expect(roadClassOf(omtClass)).toBeNull();
  });
});

// ─── Round-trip helpers ────────────────────────────────────────────────────────

/** World → tile coords using the standard Web Mercator projection. */
function lonLatToWorld(lon: number, lat: number): [number, number] {
  const worldX = lon / 360 + 0.5;
  const sinPhi = Math.sin((lat * Math.PI) / 180);
  const worldY = 0.5 - Math.log((1 + sinPhi) / (1 - sinPhi)) / (4 * Math.PI);
  return [worldX, worldY];
}

/** Build an MVT buffer from per-layer GeoJSON feature collections and decode it. */
function buildAndDecode(
  layerFeatures: Record<string, FeatureCollection>,
  z: number,
  tx: number,
  ty: number
) {
  const vtOptions = { maxZoom: z, indexMaxZoom: z, indexMaxPoints: 0 };
  const layers: Record<string, ReturnType<ReturnType<typeof geojsonvt>['getTile']> & object> = {};

  for (const [name, fc] of Object.entries(layerFeatures)) {
    const idx = geojsonvt(fc, vtOptions);
    const tile = idx.getTile(z, tx, ty);
    if (tile) layers[name] = tile;
  }

  const buf = vtpbf.fromGeojsonVt(layers, { version: 2 });
  return decodeMvtTile(new Uint8Array(buf), { z, x: tx, y: ty });
}

// ─── Round-trip test ───────────────────────────────────────────────────────────

describe('decodeMvtTile round-trip', () => {
  // Coordinates near Capitol Hill Seattle, chosen to fall within one z=14 tile.
  const LON = -122.332;
  const LAT = 47.597;
  const Z = 14;
  const [worldX, worldY] = lonLatToWorld(LON, LAT);
  const TX = Math.floor(worldX * Math.pow(2, Z));
  const TY = Math.floor(worldY * Math.pow(2, Z));
  const TILE = { z: Z, x: TX, y: TY };
  const RECT = tileWorldRect(TILE);
  // geojson-vt uses 64-unit buffer on 4096-unit extent
  const BUF = (64 / 4096) * (RECT.maxX - RECT.minX);

  // Helper: make a tiny offset so lines have ≥2 distinct points
  const d = 0.0001;

  const transportationFeatures: Feature[] = [
    // motorway with name → should produce one street (roadClass 4, name 'I-5')
    {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [LON - d, LAT],
          [LON + d, LAT],
        ],
      } satisfies LineString,
      properties: { class: 'motorway', name: 'I-5' },
    },
    // rail → should be skipped
    {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [LON - d, LAT + d * 0.3],
          [LON + d, LAT + d * 0.3],
        ],
      } satisfies LineString,
      properties: { class: 'rail' },
    },
  ];

  const waterwayFeatures: Feature[] = [
    {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [LON, LAT - d],
          [LON, LAT + d],
        ],
      } satisfies LineString,
      properties: {},
    },
  ];

  const waterFeatures: Feature[] = [
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [LON - d * 0.5, LAT - d * 0.5],
            [LON + d * 0.5, LAT - d * 0.5],
            [LON + d * 0.5, LAT + d * 0.5],
            [LON - d * 0.5, LAT + d * 0.5],
            [LON - d * 0.5, LAT - d * 0.5],
          ],
        ],
      } satisfies Polygon,
      properties: {},
    },
  ];

  const parkFeatures: Feature[] = [
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [LON + d * 0.1, LAT + d * 0.1],
            [LON + d * 0.6, LAT + d * 0.1],
            [LON + d * 0.6, LAT + d * 0.6],
            [LON + d * 0.1, LAT + d * 0.6],
            [LON + d * 0.1, LAT + d * 0.1],
          ],
        ],
      } satisfies Polygon,
      properties: { name: 'Volunteer Park' },
    },
  ];

  const landcoverFeatures: Feature[] = [
    // grass → included as park
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [LON - d * 0.6, LAT - d * 0.6],
            [LON - d * 0.1, LAT - d * 0.6],
            [LON - d * 0.1, LAT - d * 0.1],
            [LON - d * 0.6, LAT - d * 0.1],
            [LON - d * 0.6, LAT - d * 0.6],
          ],
        ],
      } satisfies Polygon,
      properties: { class: 'grass' },
    },
    // sand → skipped
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [LON - d * 0.6, LAT + d * 0.1],
            [LON - d * 0.1, LAT + d * 0.1],
            [LON - d * 0.1, LAT + d * 0.6],
            [LON - d * 0.6, LAT + d * 0.6],
            [LON - d * 0.6, LAT + d * 0.1],
          ],
        ],
      } satisfies Polygon,
      properties: { class: 'sand' },
    },
  ];

  const landuseFatures: Feature[] = [
    // cemetery → included as park
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [LON + d * 0.1, LAT - d * 0.6],
            [LON + d * 0.6, LAT - d * 0.6],
            [LON + d * 0.6, LAT - d * 0.1],
            [LON + d * 0.1, LAT - d * 0.1],
            [LON + d * 0.1, LAT - d * 0.6],
          ],
        ],
      } satisfies Polygon,
      properties: { class: 'cemetery' },
    },
    // residential → skipped
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [LON - d * 0.1, LAT + d * 0.7],
            [LON + d * 0.6, LAT + d * 0.7],
            [LON + d * 0.6, LAT + d * 1.2],
            [LON - d * 0.1, LAT + d * 1.2],
            [LON - d * 0.1, LAT + d * 0.7],
          ],
        ],
      } satisfies Polygon,
      properties: { class: 'residential' },
    },
  ];

  const placeFeatures: Feature[] = [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [LON, LAT] } satisfies Point,
      properties: { name: 'Capitol Hill', class: 'suburb', rank: 10 },
    },
  ];

  let decoded: ReturnType<typeof decodeMvtTile>;

  beforeAll(() => {
    const fc = (features: Feature[]): FeatureCollection => ({
      type: 'FeatureCollection',
      features,
    });
    decoded = buildAndDecode(
      {
        transportation: fc(transportationFeatures),
        waterway: fc(waterwayFeatures),
        water: fc(waterFeatures),
        park: fc(parkFeatures),
        landcover: fc(landcoverFeatures),
        landuse: fc(landuseFatures),
        place: fc(placeFeatures),
      },
      Z,
      TX,
      TY
    );
  });

  it('decodes exactly one motorway street named I-5 (rail skipped)', () => {
    const motorways = decoded.streets.filter((s) => s.roadClass === 4);
    expect(motorways).toHaveLength(1);
    expect(motorways[0].name).toBe('I-5');
    expect(motorways[0].roadClass).toBe(4);
  });

  it('decodes exactly one river from waterway', () => {
    expect(decoded.rivers).toHaveLength(1);
    expect(decoded.rivers[0].points.length).toBeGreaterThanOrEqual(2);
  });

  it('decodes exactly one water area with at least one ring', () => {
    expect(decoded.water).toHaveLength(1);
    expect(decoded.water[0].rings.length).toBeGreaterThanOrEqual(1);
  });

  it('parks contains named park + grass landcover + cemetery landuse (3 total)', () => {
    expect(decoded.parks).toHaveLength(3);
    const names = decoded.parks.map((p) => p.name).filter(Boolean);
    expect(names).toContain('Volunteer Park');
  });

  it('decodes one place named Capitol Hill with correct kind and rank', () => {
    expect(decoded.places).toHaveLength(1);
    const place = decoded.places[0];
    expect(place.name).toBe('Capitol Hill');
    expect(place.kind).toBe('suburb');
    expect(place.rank).toBe(10);
  });

  it('every decoded street coordinate lies within (or at the buffered edge of) the tile rect', () => {
    for (const street of decoded.streets) {
      for (const [px, py] of street.points) {
        expect(px).toBeGreaterThanOrEqual(RECT.minX - BUF);
        expect(px).toBeLessThanOrEqual(RECT.maxX + BUF);
        expect(py).toBeGreaterThanOrEqual(RECT.minY - BUF);
        expect(py).toBeLessThanOrEqual(RECT.maxY + BUF);
      }
    }
  });

  it('every decoded river coordinate lies within the buffered tile rect', () => {
    for (const river of decoded.rivers) {
      for (const [px, py] of river.points) {
        expect(px).toBeGreaterThanOrEqual(RECT.minX - BUF);
        expect(px).toBeLessThanOrEqual(RECT.maxX + BUF);
        expect(py).toBeGreaterThanOrEqual(RECT.minY - BUF);
        expect(py).toBeLessThanOrEqual(RECT.maxY + BUF);
      }
    }
  });
});

// ─── Empty tile ────────────────────────────────────────────────────────────────

describe('decodeMvtTile empty tile', () => {
  it('returns all-empty arrays when the buffer encodes no layers', () => {
    const emptyBuf = vtpbf.fromGeojsonVt({}, { version: 2 });
    const geom = decodeMvtTile(new Uint8Array(emptyBuf), { z: 14, x: 0, y: 0 });
    expect(geom.streets).toHaveLength(0);
    expect(geom.rivers).toHaveLength(0);
    expect(geom.water).toHaveLength(0);
    expect(geom.parks).toHaveLength(0);
    expect(geom.places).toHaveLength(0);
  });
});
