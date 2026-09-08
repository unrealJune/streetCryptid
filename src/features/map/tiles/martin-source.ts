import type { TileByteSource } from './tile-bytes';
import type { TileCoord } from './tile-math';
import { withRequestDeadline } from './request-deadline';
import { addMapPerfMetric, captureMapPerfMetricScope, perfNow } from '../perf/map-perf';

const TILE_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Fetches raw MVT bytes from a self-hosted OpenMapTiles server (e.g. Martin):
 * GET {baseUrl}/{z}/{x}/{y} → protobuf.
 *
 * This is the map feature's single sanctioned impure module (network). It sits
 * at the bottom of the byte chain so coarse-tile persistence
 * (bundle-fetch.ts, sqlite-tile-store.ts) can wrap it byte-for-byte;
 * lifting bytes into decoded geometry is DecodingGeometrySource's job.
 */
export class MartinByteSource implements TileByteSource {
  constructor(private readonly baseUrl: string) {}

  async getTileBytes(tile: TileCoord, signal?: AbortSignal): Promise<Uint8Array | null> {
    const metrics = captureMapPerfMetricScope();
    const url = `${this.baseUrl}/${tile.z}/${tile.x}/${tile.y}`;
    return withRequestDeadline(
      async (requestSignal) => {
        const started = metrics ? perfNow() : 0;
        const response = await fetch(url, { signal: requestSignal });
        // Servers signal "no data here" as 204 or 404 for sparse tiles.
        if (response.status === 204 || response.status === 404) return null;
        if (!response.ok) {
          throw new Error(`Tile request failed: ${response.status} ${url}`);
        }
        const buffer = await response.arrayBuffer();
        if (metrics) addMapPerfMetric('networkMs', perfNow() - started, metrics);
        addMapPerfMetric('responseBytes', buffer.byteLength, metrics);
        if (buffer.byteLength === 0) return null;
        return new Uint8Array(buffer);
      },
      TILE_REQUEST_TIMEOUT_MS,
      signal
    );
  }
}
