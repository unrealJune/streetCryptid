/**
 * Profile the region-build pipeline headlessly: tile decode → merge → feature
 * masks → cell-field build, at phone-ish viewport size. This is the CPU cost
 * of one `MapEngine.buildRegion`, i.e. what a settle pays only when the camera
 * leaves the current region (in-region pans/zooms just re-run the GPU
 * dot-field shader, which can't be measured from Node).
 *
 * Geometry is fetched overzoomed (one band level coarser than display) as the
 * map's main level-of-detail lever — the dominant cost is street
 * rasterization, so fewer/coarser tiles is the biggest win.
 *
 * Run with: bun scripts/profile-scene.ts            (bundled fixture tiles)
 *           bun scripts/profile-scene.ts <sourceUrl> (live z0-14 source, e.g.
 *           https://tiles.example.com/planet)
 *
 * Budget (plan): fetch + build ≲ 300 ms warm on device; Node numbers here are a
 * rough proxy (Hermes is slower, but the shape of the cost shows up).
 */

import {
  createExplorationIndex,
  demoExploration,
} from '../src/features/map/core/exploration-index';
import { createH3Grid, realH3 } from '../src/features/map/core/h3-grid';
import type { CameraState, Viewport } from '../src/features/map/core/types';
import { MapEngine } from '../src/features/map/engine/map-engine';
import {
  createPlanetGeometrySource,
  FIXTURE_DATA_ZOOMS,
  PLANET_DATA_ZOOMS,
} from '../src/features/map/config';
import { FIXTURE_HOME } from '../src/features/map/tiles/__fixtures__/caphill-tiles';
import { FixtureGeometrySource } from '../src/features/map/tiles/fixture-source';
import { unpackPacked } from '../src/features/map/tiles/packed-geometry';

const sourceUrl = process.argv[2];
const viewport: Viewport = { width: 390, height: 780 };
const camera: CameraState = { center: [FIXTURE_HOME[0], FIXTURE_HOME[1]], zoom: 15 };
const grid = createH3Grid(realH3());
const exploration = createExplorationIndex(grid, demoExploration(grid, FIXTURE_HOME));

const source = sourceUrl ? createPlanetGeometrySource(sourceUrl) : new FixtureGeometrySource();
const dataZooms = sourceUrl ? PLANET_DATA_ZOOMS : FIXTURE_DATA_ZOOMS;
console.log(sourceUrl ? `source: ${sourceUrl}` : 'source: bundled fixture tiles');

async function main() {
  const engine = new MapEngine({
    source,
    grid,
    dataZooms,
    onTiming: (t) =>
      console.log(
        `region: fetch+decode ${t.fetchMs.toFixed(1)} ms (${t.tiles} tiles) + ` +
          `masks/textures ${t.buildMs.toFixed(1)} ms`
      ),
  });

  const t0 = performance.now();
  const region = await engine.buildRegion({ camera, viewport, exploration });
  const t1 = performance.now();

  if (!region) {
    console.log('buildRegion returned null (superseded or empty)');
    return;
  }

  console.log(`total buildRegion: ${(t1 - t0).toFixed(1)} ms`);
  console.log(
    `mask size: ${region.spec.maskWidth}×${region.spec.maskHeight} px ` +
      `(GPU-rasterized in render layer)`
  );
  const geo = unpackPacked(region.geometry);
  console.log(
    `geometry: ${geo.streets.length} streets, ` +
      `${geo.water.length} water, ${geo.parks.length} parks`
  );
  console.log(`cell field: ${region.cellField.cells.length} cells at res ${region.cellField.res}`);
  console.log(`places: ${region.places.length}`);
}

main();
