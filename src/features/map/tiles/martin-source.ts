import type { MapGeometry } from '../core/types';
import type { GeometrySource } from './geometry-source';
import { EMPTY_GEOMETRY } from './geometry-source';
import { decodeMvtTile } from './mvt-mapping';
import type { TileCoord } from './tile-math';

/**
 * Fetches MVT tiles from a self-hosted OpenMapTiles server (e.g. Martin):
 * GET {baseUrl}/{z}/{x}/{y} → protobuf.
 *
 * This is the map feature's single sanctioned impure module (network).
 */
export class MartinGeometrySource implements GeometrySource {
  constructor(private readonly baseUrl: string) {}

  async getTile(tile: TileCoord, signal?: AbortSignal): Promise<MapGeometry> {
    const url = `${this.baseUrl}/${tile.z}/${tile.x}/${tile.y}`;
    const response = await fetch(url, { signal });
    // Servers signal "no data here" as 204 or 404 for sparse tiles.
    if (response.status === 204 || response.status === 404) return EMPTY_GEOMETRY;
    if (!response.ok) {
      throw new Error(`Tile request failed: ${response.status} ${url}`);
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0) return EMPTY_GEOMETRY;
    return decodeMvtTile(new Uint8Array(buffer), tile);
  }
}
