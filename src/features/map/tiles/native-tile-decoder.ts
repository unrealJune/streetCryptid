import { tryGetIrohLocation } from 'iroh-location';

import { concatTileParts, isGzipMember, type TileDecoder } from './decode-source';
import { packedTileToGeometry } from './packed-geometry';
import { wrapScg1 } from './scg1';
import { addMapPerfMetric, captureMapPerfMetricScope, perfNow } from '../perf/map-perf';

/**
 * The native Rust MVT decoder, exposed through the `iroh-location` Expo module,
 * as a {@link TileDecoder}. Decoding runs off the JS thread and returns a flat
 * SCG1 buffer that {@link wrapScg1} views without copying the coordinates.
 *
 * Parts go over the bridge as one buffer. Rust inflates gzip with a multi-member
 * reader, so the concatenation of a z14 tile's two members is one valid input,
 * and raw MVT parts concatenate to one valid tile directly. The FFI signature is
 * unchanged, so no binding regeneration is involved.
 *
 * Returns `null` when the native method is unavailable (web, Expo Go, or iOS
 * before `just bindgen-ios`), so `config` falls back to the JS decoder.
 */
export function createNativeTileDecoder(): TileDecoder | null {
  const mod = tryGetIrohLocation();
  if (!mod || typeof mod.decodeMvtTile !== 'function') return null;
  const decodeMvtTile = mod.decodeMvtTile.bind(mod);

  return async (parts, tile) => {
    const metrics = captureMapPerfMetricScope();
    const started = metrics ? perfNow() : 0;
    const buf = await decodeMvtTile(nativeInput(parts), tile.z, tile.x, tile.y);
    const geometry = packedTileToGeometry(wrapScg1(buf, metrics));
    addMapPerfMetric('nativeDecodeCalls', 1, metrics);
    if (metrics) addMapPerfMetric('nativeDecodeMs', perfNow() - started, metrics);
    return geometry;
  };
}

/**
 * One buffer Rust reads as a single tile: all-gzip or all-raw parts concatenate
 * as they are. A mix (never produced by the pipeline) is inflated here first,
 * because Rust sniffs only the first two bytes of its input.
 */
function nativeInput(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  const gzip = parts.filter(isGzipMember).length;
  if (gzip !== 0 && gzip !== parts.length) return concatTileParts(parts);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
