import type { WorldPoint, WorldRect } from './core/types';
import { latLonToWorld } from './core/mercator';
import { FixtureGeometrySource } from './tiles/fixture-source';
import { FIXTURE_BOUNDS, FIXTURE_HOME } from './tiles/__fixtures__/caphill-tiles';
import type { GeometrySource } from './tiles/geometry-source';
import { MartinGeometrySource } from './tiles/martin-source';
import { CachedGeometrySource } from './tiles/tile-cache';

/**
 * Hex sector circumradius in world units ≈ 42 px at z15 (the mock's hood-tier
 * cell size), ~135 m across in Seattle. Part of the exploration data contract:
 * changing it re-shapes every discovered sector.
 */
export const HEX_RADIUS_WORLD = 5e-6;

// z11 is as far out as the z12-floored tileset zooms cheaply — a whole-city
// view. Going further (state/region) would fetch hundreds of z12 tiles and
// needs a pre-baked coarse silhouette we don't have yet.
export const CAMERA_MIN_ZOOM = 11;
export const CAMERA_MAX_ZOOM = 16;
export const CAMERA_INITIAL_ZOOM = 15;

/**
 * Tile-cache capacity. Large enough to hold the two region layers the map
 * retains during a crossfade (current + previous), each up to ~50 tiles at the
 * zoomed-out end, without thrashing.
 */
const TILE_CACHE_CAPACITY = 160;

/** A geometry source plus the world it covers — what the map screen consumes. */
export interface MapDataset {
  readonly source: GeometrySource;
  /** Camera pan limits. */
  readonly bounds: WorldRect;
  /** Initial camera center + demo YOU/exploration seed (GPS replaces this later). */
  readonly home: WorldPoint;
}

/** Washington state, generously padded — pan limits for the real tileset. */
const WASHINGTON_BOUNDS: WorldRect = {
  ...(() => {
    const nw = latLonToWorld({ lat: 49.05, lon: -124.85 });
    const se = latLonToWorld({ lat: 45.45, lon: -116.9 });
    return { minX: nw[0], minY: nw[1], maxX: se[0], maxY: se[1] };
  })(),
};

const SEATTLE_HOME = latLonToWorld({ lat: 47.6205, lon: -122.3169 }); // Capitol Hill

/**
 * Choose the map's data source: a live OpenMapTiles server when
 * EXPO_PUBLIC_TILE_URL is set, the bundled Capitol Hill fixture otherwise.
 */
export function createMapDataset(): MapDataset {
  const tileUrl = process.env.EXPO_PUBLIC_TILE_URL;
  if (tileUrl) {
    return {
      source: new CachedGeometrySource(new MartinGeometrySource(tileUrl), TILE_CACHE_CAPACITY),
      bounds: WASHINGTON_BOUNDS,
      home: SEATTLE_HOME,
    };
  }
  return {
    source: new CachedGeometrySource(new FixtureGeometrySource(), TILE_CACHE_CAPACITY),
    bounds: FIXTURE_BOUNDS,
    home: FIXTURE_HOME,
  };
}
