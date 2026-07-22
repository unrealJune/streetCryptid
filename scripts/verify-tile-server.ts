/**
 * Verify the live map API against the app's contract (infra/tiles/PLAN.md).
 *
 * The custom server is the ONLY public map endpoint and enforces a privacy
 * boundary that cannot be configured away:
 *   - coarse raw XYZ is public for z0–10 only,
 *   - fine detail (z11–14) is reachable ONLY through the fixed-z10 SCB1 privacy
 *     bundle, and
 *   - Martin's /catalog is private (localhost-only) and never exposed.
 *
 * This script checks exactly that surface. It no longer probes raw z12–14 or the
 * catalog — the previous version did, which the new server (correctly) rejects.
 *
 * Transparency: rather than trusting the privacy claim, it verifies it from the
 * client's own perspective — raw z11–14 MUST return 404 — so the guarantee is
 * demonstrable. This provides coarse location quantization (the server learns
 * only your ~25 km z10 ancestor, never the child tile you are viewing), not
 * anonymity or private information retrieval.
 *
 * Run with:  bun scripts/verify-tile-server.ts <sourceUrl>
 * Example:   bun scripts/verify-tile-server.ts https://martin.junephilip.com/planet
 */

import { latLonToWorld } from '../src/features/map/core/mercator';
import { unpackPacked } from '../src/features/map/tiles/packed-geometry';
import { createPlanetGeometrySource } from '../src/features/map/config';
import { DecodingGeometrySource } from '../src/features/map/tiles/decode-source';
import { MartinByteSource } from '../src/features/map/tiles/martin-source';
import { createTileByteStore, InMemoryTileDb } from '../src/features/map/tiles/sqlite-tile-store';

const sourceUrl = process.argv[2];
if (!sourceUrl) {
  console.error('usage: bun scripts/verify-tile-server.ts <sourceUrl>');
  console.error('example: bun scripts/verify-tile-server.ts https://martin.junephilip.com/planet');
  process.exit(1);
}

const base = sourceUrl.replace(/\/+$/, '');
const SEATTLE = { lat: 47.6062, lon: -122.3321 };

function tileFor(lat: number, lon: number, z: number) {
  const [wx, wy] = latLonToWorld({ lat, lon });
  const n = 2 ** z;
  return { z, x: Math.floor(wx * n), y: Math.floor(wy * n) };
}

async function main() {
  const source = new DecodingGeometrySource(new MartinByteSource(base));
  let failed = false;

  // --- Public coarse XYZ (z0–10) ------------------------------------------
  // These pass through as ordinary tiles; the app requests them individually.
  console.log('coarse public XYZ (z0–10):');
  try {
    const world = unpackPacked(await source.getTile({ z: 0, x: 0, y: 0 }));
    console.log(`  z0 (0/0): ${world.water.length} water, ${world.places.length} places`);
    if (world.water.length === 0) {
      console.error('  ✗ z0 decodes no water — wrong schema or empty bake');
      failed = true;
    }
  } catch (error) {
    console.error('  z0 (0/0) FAILED:', (error as Error).message);
    failed = true;
  }

  for (const [z, expect] of [
    [4, 'places'],
    [7, 'streets'],
    [10, 'streets'],
  ] as const) {
    const tile = tileFor(SEATTLE.lat, SEATTLE.lon, z);
    try {
      const geo = unpackPacked(await source.getTile(tile));
      const count = expect === 'places' ? geo.places.length : geo.streets.length;
      console.log(
        `  z${z} (${tile.x}/${tile.y}): ${geo.streets.length} streets, ` +
          `${geo.water.length} water, ${geo.places.length} places`
      );
      if (count === 0) {
        console.warn(`  ⚠ no ${expect} at z${z} — check the bake's layer minzoom`);
      }
    } catch (error) {
      console.error(`  z${z} (${tile.x}/${tile.y}) FAILED:`, (error as Error).message);
      failed = true;
    }
  }

  // --- Privacy boundary: raw z11–14 must be blocked (404) ------------------
  // This is the client-side proof of the guarantee: fine child coordinates are
  // not fetchable individually, so they cannot reach the API or its access logs.
  console.log('\nprivacy boundary (raw fine XYZ must be blocked):');
  for (const z of [11, 12, 13, 14]) {
    const tile = tileFor(SEATTLE.lat, SEATTLE.lon, z);
    const url = `${base}/${tile.z}/${tile.x}/${tile.y}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      // Drain the body so the connection can be reused.
      await res.arrayBuffer().catch(() => undefined);
      if (res.status === 404) {
        console.log(`  ✓ z${z} raw → 404 (blocked, as required)`);
      } else {
        console.error(`  ✗ z${z} raw → ${res.status} — fine tiles must NOT be publicly fetchable`);
        failed = true;
      }
    } catch (error) {
      console.error(`  z${z} raw probe FAILED:`, (error as Error).message);
      failed = true;
    }
  }

  // --- Fine detail via the z10 SCB1 privacy bundle ------------------------
  // The only sanctioned path to z11–14: the app sends its fixed z10 ancestor and
  // the server returns every descendant at the requested zoom as one bundle.
  console.log('\nfine detail via the z10 privacy bundle:');
  try {
    const privateSource = createPlanetGeometrySource(
      base,
      createTileByteStore({ openDb: async () => new InMemoryTileDb() })
    );
    for (const z of [12, 13, 14]) {
      const tile = tileFor(SEATTLE.lat, SEATTLE.lon, z);
      const t0 = performance.now();
      const geo = unpackPacked(await privateSource.getTile(tile));
      const ms = (performance.now() - t0).toFixed(0);
      const places = geo.places
        .slice(0, 5)
        .map((p) => p.name)
        .join(', ');
      console.log(
        `  z${z} via z10 bundle (${tile.x}/${tile.y}): ${geo.streets.length} streets, ` +
          `${geo.water.length} water, ${geo.parks.length} parks, ${geo.rivers.length} rivers, ` +
          `${geo.places.length} places [${places}] in ${ms} ms`
      );
      if (z === 14 && geo.streets.length < 100) {
        console.error('  ✗ suspiciously few streets at z14 — not a detailed city, check the bake');
        failed = true;
      }
    }
  } catch (error) {
    console.error('  z10 privacy bundle FAILED:', (error as Error).message);
    failed = true;
  }

  if (failed) {
    console.error('\n✗ map API contract NOT verified');
    process.exit(1);
  }
  console.log(
    '\n✓ coarse z0–10 is public, raw z11–14 is blocked, and fine detail decodes ' +
      'only through the z10 privacy bundle'
  );
}

main();
