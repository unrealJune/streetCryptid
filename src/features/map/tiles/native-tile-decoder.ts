import { tryGetIrohLocation } from 'iroh-location';

import type { TileDecoder } from './decode-source';
import { packedTileToGeometry } from './packed-geometry';
import { wrapScg1 } from './scg1';
import { addMapPerfMetric, captureMapPerfMetricScope, perfNow } from '../perf/map-perf';

/**
 * The native Rust MVT decoder, exposed through the `iroh-location` Expo module,
 * as a {@link TileDecoder}. Decoding runs off the JS thread and returns a flat
 * SCG1 buffer that {@link wrapScg1} views without copying the coordinates.
 *
 * Returns `null` when the native method is unavailable (web, Expo Go, or iOS
 * before `just bindgen-ios`), so `config` falls back to the JS decoder.
 */
export function createNativeTileDecoder(): TileDecoder | null {
  const mod = tryGetIrohLocation();
  if (!mod || typeof mod.decodeMvtTile !== 'function') return null;
  const decodeMvtTile = mod.decodeMvtTile.bind(mod);

  return async (bytes, tile) => {
    const metrics = captureMapPerfMetricScope();
    const started = metrics ? perfNow() : 0;
    const buf = await decodeMvtTile(bytes, tile.z, tile.x, tile.y);
    const geometry = packedTileToGeometry(wrapScg1(buf, metrics));
    addMapPerfMetric('nativeDecodeCalls', 1, metrics);
    if (metrics) addMapPerfMetric('nativeDecodeMs', perfNow() - started, metrics);
    return geometry;
  };
}
