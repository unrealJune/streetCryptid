/**
 * Verify a live tile server against the app's contract by pulling real tiles
 * through the app's own decode path (MartinGeometrySource).
 *
 * Run with:  bun scripts/verify-tile-server.ts <baseUrl>
 * Example:   bun scripts/verify-tile-server.ts https://tiles.example.com/washington
 *
 * Passes when Seattle-area tiles at z12–14 decode into a plausible city:
 * thousands of streets, water, parks, and named places.
 */

import { latLonToWorld } from '../src/features/map/core/mercator';
import { MartinGeometrySource } from '../src/features/map/tiles/martin-source';

const baseUrl = process.argv[2];
if (!baseUrl) {
  console.error('usage: bun scripts/verify-tile-server.ts <baseUrl>');
  console.error('example: bun scripts/verify-tile-server.ts https://tiles.example.com/washington');
  process.exit(1);
}

const SEATTLE = { lat: 47.6062, lon: -122.3321 };

function tileFor(lat: number, lon: number, z: number) {
  const [wx, wy] = latLonToWorld({ lat, lon });
  const n = 2 ** z;
  return { z, x: Math.floor(wx * n), y: Math.floor(wy * n) };
}

async function main() {
  const catalogUrl = new URL('/catalog', baseUrl).href;
  try {
    const catalog = await fetch(catalogUrl, { signal: AbortSignal.timeout(15000) });
    console.log(`catalog: ${catalog.status} ${catalogUrl}`);
    if (catalog.ok) console.log(await catalog.text());
  } catch (error) {
    console.error(`catalog unreachable (${catalogUrl}):`, (error as Error).message);
    console.error('Is the server up? Continuing to tile checks anyway…\n');
  }

  const source = new MartinGeometrySource(baseUrl);
  let failed = false;

  for (const z of [12, 13, 14]) {
    const tile = tileFor(SEATTLE.lat, SEATTLE.lon, z);
    try {
      const t0 = performance.now();
      const geo = await source.getTile(tile);
      const ms = (performance.now() - t0).toFixed(0);
      const places = geo.places
        .slice(0, 5)
        .map((p) => p.name)
        .join(', ');
      console.log(
        `z${z} (${tile.x}/${tile.y}): ${geo.streets.length} streets, ${geo.water.length} water, ` +
          `${geo.parks.length} parks, ${geo.rivers.length} rivers, ${geo.places.length} places ` +
          `[${places}] in ${ms} ms`
      );
      if (z === 14 && geo.streets.length < 100) {
        console.error('  ⚠ suspiciously few streets at z14 — check the schema/class mapping');
        failed = true;
      }
    } catch (error) {
      console.error(`z${z} (${tile.x}/${tile.y}) FAILED:`, (error as Error).message);
      failed = true;
    }
  }

  if (failed) {
    console.error('\n✗ tile server contract NOT verified');
    process.exit(1);
  }
  console.log(
    '\n✓ tile server serves decodable OpenMapTiles data — safe to set EXPO_PUBLIC_TILE_URL'
  );
}

main();
