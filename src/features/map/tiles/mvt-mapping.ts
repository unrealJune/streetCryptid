/**
 * Decode a Mapbox Vector Tile (OpenMapTiles schema) into the map core's
 * `MapGeometry`, with all coordinates already in normalized world space.
 *
 * Pure: bytes in, plain data out. The layers/classes read here follow the
 * OpenMapTiles tile-server schema.
 */

import { VectorTile, VectorTileFeature, VectorTileLayer } from '@mapbox/vector-tile';

import type {
  AreaFeature,
  MapGeometry,
  Place,
  RiverWay,
  RoadClass,
  StreetWay,
  TransitMode,
  TransitWay,
  WorldPoint,
} from '../core/types';
import type { TileCoord } from './tile-math';
import { tileWorldRect } from './tile-math';
import { Utf8PbfReader } from './utf8-pbf-reader';

/**
 * OMT `transportation.class` → the mock's 0–4 road class. Classes that aren't
 * ground roads (rail, ferry, aerialway…) map to null and are skipped.
 */
export function roadClassOf(omtClass: string): RoadClass | null {
  switch (omtClass) {
    case 'motorway':
      return 4;
    // Trunk roads are arterials, not freeways: OMT tags plenty of ordinary
    // divided city streets `trunk`, and at class 4 they drew as thick bars
    // through the middle of a neighbourhood. They ride with primary instead.
    case 'trunk':
    case 'primary':
      return 3;
    case 'secondary':
    case 'tertiary':
      return 2;
    case 'minor':
    case 'busway':
      return 1;
    case 'service':
    case 'track':
    case 'path':
    case 'raceway':
      return 0;
    default:
      return null;
  }
}

/**
 * OMT `transportation.class`/`subclass` → a transit mode, for the lines
 * `roadClassOf` rejects. `class` is the coarse bucket (`rail` for heavy rail,
 * `transit` for urban rail, `ferry` for boats); `subclass` carries the OSM
 * railway/route value. Anything that isn't rail-or-boat (roads, aerialways)
 * returns null.
 *
 * Mirrored exactly by `transit_mode_of` in
 * `modules/iroh-location/rust/src/mvt.rs` — change both together.
 */
export function transitModeOf(omtClass: string, subclass: string): TransitMode | null {
  if (omtClass === 'ferry') return 'ferry';
  if (omtClass !== 'rail' && omtClass !== 'transit') return null;
  switch (subclass) {
    case 'subway':
      return 'subway';
    case 'light_rail':
      return 'light_rail';
    case 'tram':
      return 'tram';
    case 'monorail':
      return 'monorail';
    case 'funicular':
      return 'funicular';
    default:
      // rail / narrow_gauge / preserved / service / missing: heavy rail.
      return 'rail';
  }
}

/** Landcover/landuse classes that read as parkland in the dot field. */
const PARK_LANDCOVER = new Set(['grass', 'wood']);
const PARK_LANDUSE = new Set(['cemetery', 'grass', 'recreation_ground', 'stadium', 'pitch']);

const GEOM_LINE = 2;
const GEOM_POLYGON = 3;

export function decodeMvtTile(data: Uint8Array, tile: TileCoord): MapGeometry {
  const vt = new VectorTile(new Utf8PbfReader(data));
  const rect = tileWorldRect(tile);
  const spanX = rect.maxX - rect.minX;
  const spanY = rect.maxY - rect.minY;

  const streets: StreetWay[] = [];
  const labelStreets: StreetWay[] = [];
  const transit: TransitWay[] = [];
  const rivers: RiverWay[] = [];
  const water: AreaFeature[] = [];
  const parks: AreaFeature[] = [];
  const places: Place[] = [];

  function toWorld(layer: VectorTileLayer, px: number, py: number): WorldPoint {
    return [rect.minX + (px / layer.extent) * spanX, rect.minY + (py / layer.extent) * spanY];
  }

  function lines(layer: VectorTileLayer, f: VectorTileFeature): WorldPoint[][] {
    return f.loadGeometry().map((ring) => ring.map((p) => toWorld(layer, p.x, p.y)));
  }

  function eachFeature(name: string, fn: (f: VectorTileFeature, layer: VectorTileLayer) => void) {
    const layer = vt.layers[name];
    if (!layer) return;
    for (let i = 0; i < layer.length; i++) fn(layer.feature(i), layer);
  }

  eachFeature('transportation', (f, layer) => {
    if (f.type !== GEOM_LINE) return;
    const omtClass = String(f.properties.class ?? '');
    const name = typeof f.properties.name === 'string' ? f.properties.name : undefined;
    const roadClass = roadClassOf(omtClass);
    if (roadClass === null) {
      const mode = transitModeOf(omtClass, String(f.properties.subclass ?? ''));
      if (mode === null) return;
      for (const points of lines(layer, f)) {
        if (points.length >= 2) transit.push({ mode, name, points });
      }
      return;
    }
    for (const points of lines(layer, f)) {
      if (points.length >= 2) streets.push({ roadClass, name, points });
    }
  });

  eachFeature('transportation_name', (f, layer) => {
    if (f.type !== GEOM_LINE) return;
    const name = typeof f.properties.name === 'string' ? f.properties.name : undefined;
    if (!name) return;
    const roadClass = roadClassOf(String(f.properties.class ?? ''));
    if (roadClass === null) return;
    for (const points of lines(layer, f)) {
      if (points.length >= 2) labelStreets.push({ roadClass, name, points });
    }
  });

  eachFeature('waterway', (f, layer) => {
    if (f.type !== GEOM_LINE) return;
    for (const points of lines(layer, f)) {
      if (points.length >= 2) rivers.push({ points });
    }
  });

  eachFeature('water', (f, layer) => {
    if (f.type !== GEOM_POLYGON) return;
    const rings = lines(layer, f);
    if (rings.length) water.push({ rings });
  });

  const pushPark = (f: VectorTileFeature, layer: VectorTileLayer) => {
    const rings = lines(layer, f);
    const name = typeof f.properties.name === 'string' ? f.properties.name : undefined;
    if (rings.length) parks.push({ name, rings });
  };
  eachFeature('park', (f, layer) => {
    if (f.type === GEOM_POLYGON) pushPark(f, layer);
  });
  eachFeature('landcover', (f, layer) => {
    if (f.type === GEOM_POLYGON && PARK_LANDCOVER.has(String(f.properties.class ?? '')))
      pushPark(f, layer);
  });
  eachFeature('landuse', (f, layer) => {
    if (f.type === GEOM_POLYGON && PARK_LANDUSE.has(String(f.properties.class ?? '')))
      pushPark(f, layer);
  });

  eachFeature('place', (f, layer) => {
    const name = f.properties.name;
    if (typeof name !== 'string' || !name) return;
    const geom = f.loadGeometry();
    if (!geom.length || !geom[0].length) return;
    const world = toWorld(layer, geom[0][0].x, geom[0][0].y);
    places.push({
      name,
      world,
      kind: String(f.properties.class ?? ''),
      rank: typeof f.properties.rank === 'number' ? f.properties.rank : undefined,
    });
  });

  return { streets, labelStreets, transit, rivers, water, parks, places };
}
