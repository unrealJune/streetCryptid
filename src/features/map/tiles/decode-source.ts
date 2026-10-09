import { gunzipSync } from 'fflate';

import type { GeometrySource, PreviewListener } from './geometry-source';
import { EMPTY_GEOMETRY, mergeGeometry } from './geometry-source';
import { decodeMvtTile } from './mvt-mapping';
import { packGeometry, type PackedGeometry } from './packed-geometry';
import type { TileByteSource, TilePayload } from './tile-bytes';
import type { TileCoord } from './tile-math';
import { addMapPerfMetric, captureMapPerfMetricScope, perfNow } from '../perf/map-perf';

/**
 * Decodes one tile into {@link PackedGeometry}. Each part is raw MVT or one
 * complete gzip member, and the tile is the MVT parse of the parts' inflated
 * concatenation (an MVT is only `repeated Layer layers = 3`, so concatenating
 * two tiles' layers yields one valid tile). The native Rust decoder (off the JS
 * thread) is injected by `config`; the default is the JS decoder packed into the
 * same typed-array form (web + iOS-until-bindgen).
 */
export type TileDecoder = (
  parts: readonly Uint8Array[],
  tile: TileCoord
) => Promise<PackedGeometry> | PackedGeometry;

/** Bound on one inflated part, matching the server's `mvt.MaxTileBytes`. */
export const MAX_INFLATED_TILE_BYTES = 16 * 1024 * 1024;

/**
 * `1f 8b` opens every gzip member. A raw MVT can never start with `0x1f`: that
 * tag would be field 3 with wire type 7, which does not exist.
 */
export function isGzipMember(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** Raw MVT for one part. Each gzip member must be inflated alone: see below. */
export function inflateTilePart(part: Uint8Array): Uint8Array {
  if (!isGzipMember(part)) return part;
  // fflate reads only the FIRST member but sizes its output from the LAST
  // trailer, so a concatenation silently truncates. One member per call.
  const view = new DataView(part.buffer, part.byteOffset, part.byteLength);
  const size = view.getUint32(part.byteLength - 4, true);
  if (size > MAX_INFLATED_TILE_BYTES) throw new Error('Tile inflates past its bound');
  const raw = gunzipSync(part, { out: new Uint8Array(size) });
  if (raw.length !== size) throw new Error('Tile gzip size does not match its trailer');
  return raw;
}

/** One raw MVT buffer for a whole tile: every part inflated, then concatenated. */
export function concatTileParts(parts: readonly Uint8Array[]): Uint8Array {
  const raw = parts.map(inflateTilePart);
  if (raw.length === 1) return raw[0];
  const out = new Uint8Array(raw.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of raw) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Pure JS decode path: MVT → MapGeometry → packed typed arrays. */
export const jsTileDecoder: TileDecoder = (parts, tile) =>
  packGeometry(decodeMvtTile(concatTileParts(parts), tile));

function partsOf(payload: TilePayload): readonly Uint8Array[] {
  return (payload instanceof Uint8Array ? [payload] : payload).filter((p) => p.byteLength > 0);
}

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
    const metrics = captureMapPerfMetricScope();
    const byteStarted = metrics ? perfNow() : 0;
    const payload = await this.bytes.getTileBytes(tile, signal);
    if (metrics) addMapPerfMetric('byteLoadMs', perfNow() - byteStarted, metrics);
    const parts = payload === null ? [] : partsOf(payload);
    if (!parts.length) return EMPTY_GEOMETRY;
    const decodeStarted = metrics ? perfNow() : 0;
    const geometry = await this.decode(parts, tile);
    addMapPerfMetric('tileDecodeCalls', 1, metrics);
    if (metrics) addMapPerfMetric('tileDecodeMs', perfNow() - decodeStarted, metrics);
    return geometry;
  }

  async getPreview(tiles: readonly TileCoord[], onStage: PreviewListener): Promise<void> {
    await this.bytes.getPreviewTiles?.(tiles, async (stage, entries) => {
      const geometry = mergeGeometry(
        await Promise.all(
          entries.map(({ tile, bytes }) =>
            bytes && bytes.byteLength ? this.decode([bytes], tile) : EMPTY_GEOMETRY
          )
        )
      );
      await onStage(stage, geometry);
    });
  }
}
