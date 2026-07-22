import type { GeometrySource } from './geometry-source';
import { EMPTY_GEOMETRY } from './geometry-source';
import { decodeMvtTile } from './mvt-mapping';
import { packGeometry, type PackedGeometry } from './packed-geometry';
import type { TileByteSource } from './tile-bytes';
import type { TileCoord } from './tile-math';

/**
 * Decodes one tile's raw MVT bytes into {@link PackedGeometry}. The native Rust
 * decoder (off the JS thread) is injected by `config`; the default is the JS
 * decoder packed into the same typed-array form (web + iOS-until-bindgen).
 */
export type TileDecoder = (
  bytes: Uint8Array,
  tile: TileCoord
) => Promise<PackedGeometry> | PackedGeometry;

/** Pure JS decode path: MVT → MapGeometry → packed typed arrays. */
export const jsTileDecoder: TileDecoder = (bytes, tile) => packGeometry(decodeMvtTile(bytes, tile));

/**
 * Lifts a byte-level source into the decoded {@link GeometrySource} seam the
 * map engine consumes. `null` bytes (tile absent upstream) decode to empty
 * geometry, mirroring MartinGeometrySource's 204/404 handling.
 */
export class DecodingGeometrySource implements GeometrySource {
  constructor(
    private readonly bytes: TileByteSource,
    private readonly decode: TileDecoder = jsTileDecoder
  ) {}

  async getTile(tile: TileCoord, signal?: AbortSignal): Promise<PackedGeometry> {
    const raw = await this.bytes.getTileBytes(tile, signal);
    if (raw === null || raw.byteLength === 0) return EMPTY_GEOMETRY;
    return this.decode(raw, tile);
  }
}
