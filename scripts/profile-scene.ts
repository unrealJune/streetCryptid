/**
 * Profile the region-build pipeline headlessly across the same deterministic
 * launch/zoom/pan sequence as the simulator harness. This covers request
 * quantization, byte caching, network, JS MVT decode, merge, and H3 cell-field
 * construction. Skia raster and native FFI remain simulator-only measurements.
 *
 * Geometry is fetched overzoomed (one band level coarser than display) as the
 * map's main level-of-detail lever — the dominant cost is street
 * rasterization, so fewer/coarser tiles is the biggest win.
 *
 * Run with:
 *   bun scripts/profile-scene.ts
 *   bun scripts/profile-scene.ts <sourceUrl>
 */

import {
  createExplorationIndex,
  demoExploration,
} from '../src/features/map/core/exploration-index';
import { createH3Grid, realH3 } from '../src/features/map/core/h3-grid';
import type { CameraState, Viewport } from '../src/features/map/core/types';
import { MapEngine } from '../src/features/map/engine/map-engine';
import {
  beginMapPerfScenario,
  configureMapPerfRun,
  createMapPerfScenarios,
  snapshotMapPerfPipeline,
  type MapPerfScenarioName,
} from '../src/features/map/perf/map-perf';
import { FIXTURE_HOME } from '../src/features/map/tiles/__fixtures__/caphill-tiles';
import { BundleFetchByteSource } from '../src/features/map/tiles/bundle-fetch';
import { DecodingGeometrySource } from '../src/features/map/tiles/decode-source';
import { FixtureGeometrySource } from '../src/features/map/tiles/fixture-source';
import type { GeometrySource } from '../src/features/map/tiles/geometry-source';
import { MartinByteSource } from '../src/features/map/tiles/martin-source';
import { unpackPacked } from '../src/features/map/tiles/packed-geometry';
import { createTileByteStore, InMemoryTileDb } from '../src/features/map/tiles/sqlite-tile-store';
import { CachedGeometrySource } from '../src/features/map/tiles/tile-cache';
import {
  MartinTileBundleSource,
  TILE_BUNDLE_ANCHOR_ZOOM,
} from '../src/features/map/tiles/tile-bundle';
import type { DataZoomRange } from '../src/features/map/tiles/tile-math';

const sourceUrl = process.argv[2];
const viewport: Viewport = { width: 390, height: 780 };
const anchor: CameraState = { center: [FIXTURE_HOME[0], FIXTURE_HOME[1]], zoom: 15 };
const FIXTURE_DATA_ZOOMS: DataZoomRange = { min: 12, max: 14 };
const PLANET_DATA_ZOOMS: DataZoomRange = { min: 0, max: 14 };
const TILE_CACHE_CAPACITY = 160;
const TILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

configureMapPerfRun(`host-${Date.now()}`);
console.log(sourceUrl ? 'source: live privacy-bundle endpoint' : 'source: bundled fixture tiles');

async function main() {
  const grid = createH3Grid(realH3());
  const exploration = createExplorationIndex(grid, demoExploration(grid, FIXTURE_HOME));
  const source = sourceUrl ? createLiveSource(sourceUrl) : createFixtureSource();
  const dataZooms = sourceUrl ? PLANET_DATA_ZOOMS : FIXTURE_DATA_ZOOMS;
  let latestTiming = null;
  const engine = new MapEngine({
    source,
    grid,
    dataZooms,
    onTiming: (timing) => {
      latestTiming = timing;
    },
  });

  const scenarios: readonly { name: MapPerfScenarioName; camera: CameraState }[] = [
    { name: 'launch', camera: anchor },
    ...createMapPerfScenarios(anchor, viewport),
  ];

  for (const scenario of scenarios) {
    beginMapPerfScenario(scenario.name);
    const started = performance.now();
    const region = await engine.buildRegion({
      camera: scenario.camera,
      viewport,
      exploration,
      explorationVersion: 0,
    });
    const totalMs = performance.now() - started;
    if (!region) throw new Error(`Scenario ${scenario.name} was superseded`);

    const geo = unpackPacked(region.geometry);
    console.log(
      JSON.stringify({
        scenario: scenario.name,
        totalMs,
        engine: latestTiming,
        pipeline: snapshotMapPerfPipeline(),
        output: {
          mask: [region.spec.maskWidth, region.spec.maskHeight],
          cells: region.cellField.cells.length,
          streets: geo.streets.length,
          water: geo.water.length,
          parks: geo.parks.length,
          places: region.places.length,
        },
      })
    );
  }
}

function createFixtureSource(): GeometrySource {
  return new CachedGeometrySource(new FixtureGeometrySource(), TILE_CACHE_CAPACITY);
}

function createLiveSource(tileUrl: string): GeometrySource {
  const store = createTileByteStore({
    openDb: async () => new InMemoryTileDb(),
  });
  return new CachedGeometrySource(
    new DecodingGeometrySource(
      new BundleFetchByteSource({
        coarseUpstream: new MartinByteSource(tileUrl),
        bundleUpstream: new MartinTileBundleSource(tileUrl),
        store,
        sourceId: 'planet-z10-v1',
        anchorZoom: TILE_BUNDLE_ANCHOR_ZOOM,
        ttlMs: TILE_TTL_MS,
      })
    ),
    TILE_CACHE_CAPACITY
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(sourceUrl ? message.replaceAll(sourceUrl, '<tile-url>') : message);
  process.exitCode = 1;
});
