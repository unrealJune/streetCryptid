import type { WorldPoint, WorldRect } from './core/types';
import { latLonToWorld } from './core/mercator';
import { FixtureGeometrySource } from './tiles/fixture-source';
import { FIXTURE_BOUNDS, FIXTURE_HOME } from './tiles/__fixtures__/caphill-tiles';
import { BundleFetchByteSource } from './tiles/bundle-fetch';
import { DecodingGeometrySource } from './tiles/decode-source';
import type { GeometrySource } from './tiles/geometry-source';
import { MartinByteSource } from './tiles/martin-source';
import { createNativeTileDecoder } from './tiles/native-tile-decoder';
import { createTileByteStore } from './tiles/sqlite-tile-store';
import { CachedGeometrySource } from './tiles/tile-cache';
import { MartinTileBundleSource, TILE_BUNDLE_ANCHOR_ZOOM } from './tiles/tile-bundle';
import type { TileByteStore } from './tiles/tile-bytes';
import { WORLD_RECT, type DataZoomRange } from './tiles/tile-math';

/**
 * Camera zoom limits. The fixture dataset keeps a city floor (it only has
 * Capitol Hill data); the live planet dataset opens to a whole-globe view
 * (z1: the world is 512 logical px wide — camera clamps center-lock smaller
 * worlds, so no gesture special-casing is needed).
 */
export const CAMERA_MIN_ZOOM = 11;
export const PLANET_CAMERA_MIN_ZOOM = 1;
/**
 * Zoom-in ceiling. Four levels past the tileset's z14 bake: `dataZoomFor` clamps
 * the fetch at z13 either way, so this costs no extra tiles — it only lets the
 * camera magnify vectors it already has. Every LOD width scale (road/structure/
 * transit/river) saturates at 1 by z14–15 and `lodForZoom` clamps to 0 above
 * z14, so nothing downstream needs a new band.
 */
export const CAMERA_MAX_ZOOM = 18;
export const CAMERA_INITIAL_ZOOM = 15;

/**
 * Closest the camera is allowed to be when it flies somewhere on purpose — tapping a friend,
 * tapping a roster row, pressing Locate Me. About 5 km across a phone screen: town-wide, where
 * the street grid is legible and "who is near me" is answerable at a glance.
 *
 * A FLOOR, not a target. Fly-to used to preserve whatever zoom the user was on, so pressing
 * Locate Me from a regional view re-centred on a dot in an unreadable field and looked like it
 * had done nothing. Someone already zoomed closer than this keeps their zoom — they chose it, and
 * yanking them back out is the same failure in the other direction.
 */
export const LOCATE_MIN_ZOOM = 13;

/** The planet bake's contiguous data zooms; the fixture carries only z12–14. */
export const PLANET_DATA_ZOOMS: DataZoomRange = { min: 0, max: 14 };
export const FIXTURE_DATA_ZOOMS: DataZoomRange = { min: 12, max: 14 };

/**
 * Tile-cache capacity (decoded tiles, memory LRU). Large enough to hold the
 * two region layers the map retains during a crossfade (current + previous),
 * each up to ~50 tiles at the zoomed-out end, without thrashing.
 */
const TILE_CACHE_CAPACITY = 160;

/**
 * Finest position the tile server is allowed to learn (~25–27 km in Seattle).
 * Any finer request becomes one SCB1 bundle request keyed only by its z10
 * ancestor; z0–10 tiles pass through individually.
 */
export const PRIVACY_ANCHOR_ZOOM = TILE_BUNDLE_ANCHOR_ZOOM;

/**
 * How long persisted tiles stay fresh. The tileset rebakes occasionally, so
 * tiles do expire — but expiry costs a re-reveal of the bundle's anchor cell to
 * the server, so it is deliberately long. Stale tiles still render offline.
 */
const TILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A geometry source plus the world it covers — what the map screen consumes. */
export interface MapDataset {
  readonly source: GeometrySource;
  /** The tileset's contiguous data zoom range. */
  readonly dataZooms: DataZoomRange;
  /** Camera pan limits. */
  readonly bounds: WorldRect;
  /** Camera zoom limits. */
  readonly minZoom: number;
  readonly maxZoom: number;
  /** Initial camera center + demo YOU/exploration seed (GPS replaces this later). */
  readonly home: WorldPoint;
  /** Where exploration state comes from: the real trail, or the demo walks. */
  readonly explorationMode: 'live' | 'demo';
}

const SEATTLE_HOME = latLonToWorld({ lat: 47.6205, lon: -122.3169 }); // Capitol Hill

/**
 * Choose the map's data source. One switch (a literal `process.env` access —
 * Hermes release builds inline it): `EXPO_PUBLIC_TILE_URL` is the planet
 * tileset url of the infra contract (infra/tiles/PLAN.md) — a single z0–14
 * OpenMapTiles source at `GET {url}/{z}/{x}/{y}`, world coverage, no regional
 * splits. Set → global mapping with live trail-backed exploration; unset →
 * the bundled Capitol Hill fixture (offline dev/test dataset: no sqlite, no
 * network, demo walks).
 *
 * Privacy: the chain is memory-LRU → decode → bundle-quantized fetch →
 * SQLite + network. Fine child XYZ coordinates never leave the app: z11–14
 * requests become one fixed z10 bundle request, and repeat visits are served
 * from SQLite.
 */
export function createMapDataset(): MapDataset {
  const tileUrl = process.env.EXPO_PUBLIC_TILE_URL;

  if (!tileUrl) {
    return {
      source: new CachedGeometrySource(new FixtureGeometrySource(), TILE_CACHE_CAPACITY),
      dataZooms: FIXTURE_DATA_ZOOMS,
      bounds: FIXTURE_BOUNDS,
      minZoom: CAMERA_MIN_ZOOM,
      maxZoom: CAMERA_MAX_ZOOM,
      home: FIXTURE_HOME,
      explorationMode: 'demo',
    };
  }

  const source = createPlanetGeometrySource(tileUrl);

  return {
    source,
    dataZooms: PLANET_DATA_ZOOMS,
    bounds: WORLD_RECT,
    minZoom: PLANET_CAMERA_MIN_ZOOM,
    maxZoom: CAMERA_MAX_ZOOM,
    home: SEATTLE_HOME,
    explorationMode: 'live',
  };
}

/** Assemble the live source exactly once so app code and diagnostic scripts cannot drift. */
export function createPlanetGeometrySource(
  tileUrl: string,
  store: TileByteStore = createTileByteStore()
): GeometrySource {
  return new CachedGeometrySource(
    new DecodingGeometrySource(
      new BundleFetchByteSource({
        coarseUpstream: new MartinByteSource(tileUrl),
        bundleUpstream: new MartinTileBundleSource(tileUrl),
        store,
        sourceId: 'planet-z10-v1',
        anchorZoom: PRIVACY_ANCHOR_ZOOM,
        ttlMs: TILE_TTL_MS,
      }),
      // Native Rust decoder (off the JS thread) when available; else JS default.
      createNativeTileDecoder() ?? undefined
    ),
    TILE_CACHE_CAPACITY
  );
}
