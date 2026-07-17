import type { MapGeometry } from '../core/types';
import type { GeometrySource } from './geometry-source';
import { EMPTY_GEOMETRY } from './geometry-source';
import { decodeMvtTile } from './mvt-mapping';
import type { TileByteSource } from './tile-bytes';
import type { TileCoord } from './tile-math';

/**
 * Lifts a byte-level source into the decoded {@link GeometrySource} seam the
 * map engine consumes. `null` bytes (tile absent upstream) decode to empty
 * geometry, mirroring MartinGeometrySource's 204/404 handling.
 */
export class DecodingGeometrySource implements GeometrySource {
  constructor(private readonly bytes: TileByteSource) {}

  async getTile(tile: TileCoord, signal?: AbortSignal): Promise<MapGeometry> {
    const raw = await this.bytes.getTileBytes(tile, signal);
    if (raw === null || raw.byteLength === 0) return EMPTY_GEOMETRY;
    return decodeMvtTile(raw, tile);
  }
}
