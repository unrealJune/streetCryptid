/**
 * Profile the region-build pipeline headlessly: tile decode → merge → feature
 * masks → mask/hex texture packing, at phone-ish viewport size. This is the CPU
 * cost of one `MapEngine.buildRegion`, i.e. what a settle pays only when the
 * camera leaves the current region (in-region pans/zooms just re-run the GPU
 * dot-field shader, which can't be measured from Node).
 *
 * Geometry is fetched overzoomed (`dataZoomFor`, one level coarser than display)
 * as the map's main level-of-detail lever — the dominant cost is street
 * rasterization, so fewer/coarser tiles is the biggest win.
 *
 * Run with: bun scripts/profile-scene.ts            (bundled fixture tiles)
 *           bun scripts/profile-scene.ts <baseUrl>  (live server, e.g.
 *           https://tiles.example.com/washington)
 *
 * Budget (plan): fetch + build ≲ 300 ms warm on device; Node numbers here are a
 * rough proxy (Hermes is slower, but the shape of the cost shows up).
 */

import { HEX_RADIUS_WORLD } from '../src/features/map/config';
import { demoExploration } from '../src/features/map/core/exploration';
import { createHexGrid } from '../src/features/map/core/hex';
import type { CameraState, Viewport } from '../src/features/map/core/types';
import { MapEngine } from '../src/features/map/engine/map-engine';
import { FIXTURE_HOME } from '../src/features/map/tiles/__fixtures__/caphill-tiles';
import { FixtureGeometrySource } from '../src/features/map/tiles/fixture-source';
import { MartinGeometrySource } from '../src/features/map/tiles/martin-source';

const baseUrl = process.argv[2];
const viewport: Viewport = { width: 390, height: 780 };
const camera: CameraState = { center: [FIXTURE_HOME[0], FIXTURE_HOME[1]], zoom: 15 };
const grid = createHexGrid(HEX_RADIUS_WORLD);
const exploration = demoExploration(grid, FIXTURE_HOME);

const source = baseUrl ? new MartinGeometrySource(baseUrl) : new FixtureGeometrySource();
console.log(baseUrl ? `source: ${baseUrl}` : 'source: bundled fixture tiles');

async function main() {
  const engine = new MapEngine({
    source,
    grid,
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
  console.log(
    `geometry: ${region.geometry.streets.length} streets, ` +
      `${region.geometry.water.length} water, ${region.geometry.parks.length} parks`
  );
  console.log(`hex table: ${region.hexTable.cols}×${region.hexTable.rows} cells`);
  console.log(`places: ${region.places.length}`);
}

main();
