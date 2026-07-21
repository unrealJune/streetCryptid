import type { TileCoord } from './tile-math';

export const TILE_BUNDLE_MEDIA_TYPE = 'application/vnd.streetcryptid.tile-bundle';
export const TILE_BUNDLE_VERSION = 1;
export const TILE_BUNDLE_ANCHOR_ZOOM = 10;
export const TILE_BUNDLE_MAX_ZOOM = 14;
export const TILE_BUNDLE_MAX_BYTES = 64 * 1024 * 1024;

const TILE_BUNDLE_MAGIC = [0x53, 0x43, 0x42, 0x31] as const; // SCB1
const TILE_BUNDLE_HEADER_BYTES = 20;
const EMPTY_TILE_LENGTH = 0xffffffff;
const TILE_BUNDLE_TIMEOUT_MS = 60_000;

export interface TileBundleRequest {
  readonly anchorZoom: number;
  readonly anchorX: number;
  readonly anchorY: number;
  readonly tileZoom: number;
}

export interface TileBundleEntry {
  readonly tile: TileCoord;
  readonly bytes: Uint8Array | null;
}

export interface TileBundleSource {
  getBundle(request: TileBundleRequest): Promise<readonly TileBundleEntry[]>;
}

export function bundleRequestFor(tile: TileCoord, anchorZoom: number): TileBundleRequest {
  if (tile.z <= anchorZoom) {
    throw new Error(`Tile z${tile.z} does not need a z${anchorZoom} privacy bundle`);
  }
  const d = tile.z - anchorZoom;
  const request = {
    anchorZoom,
    anchorX: tile.x >> d,
    anchorY: tile.y >> d,
    tileZoom: tile.z,
  };
  validateRequest(request);
  return request;
}

export function bundleKeyOf(request: TileBundleRequest): string {
  return `${request.anchorZoom}/${request.anchorX}/${request.anchorY}@${request.tileZoom}`;
}

/** Every tile at `tileZoom` beneath the fixed bundle anchor, in row-major order. */
export function bundleTiles(request: TileBundleRequest): TileCoord[] {
  validateRequest(request);
  const d = request.tileZoom - request.anchorZoom;
  const side = 1 << d;
  const x0 = request.anchorX << d;
  const y0 = request.anchorY << d;
  const tiles: TileCoord[] = [];
  for (let y = y0; y < y0 + side; y++) {
    for (let x = x0; x < x0 + side; x++) {
      tiles.push({ z: request.tileZoom, x, y });
    }
  }
  return tiles;
}

export function validateTileBundleEntries(
  request: TileBundleRequest,
  entries: readonly TileBundleEntry[]
): void {
  const expected = bundleTiles(request);
  if (entries.length !== expected.length) {
    throw new Error(
      `Tile bundle entry count mismatch: expected ${expected.length}, got ${entries.length}`
    );
  }
  for (let i = 0; i < expected.length; i++) {
    const want = expected[i];
    const got = entries[i].tile;
    if (got.z !== want.z || got.x !== want.x || got.y !== want.y) {
      throw new Error(
        `Tile bundle entry ${i} mismatch: expected ${want.z}/${want.x}/${want.y}, got ${got.z}/${got.x}/${got.y}`
      );
    }
  }
}

/** Decode and strictly validate one SCB1 response against the request that produced it. */
export function decodeTileBundle(
  bytes: Uint8Array,
  request: TileBundleRequest
): readonly TileBundleEntry[] {
  validateRequest(request);
  if (bytes.byteLength < TILE_BUNDLE_HEADER_BYTES) {
    throw new Error('Tile bundle is shorter than the SCB1 header');
  }
  for (let i = 0; i < TILE_BUNDLE_MAGIC.length; i++) {
    if (bytes[i] !== TILE_BUNDLE_MAGIC[i]) throw new Error('Tile bundle has invalid SCB1 magic');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(4);
  const anchorZoom = view.getUint8(5);
  const tileZoom = view.getUint8(6);
  const flags = view.getUint8(7);
  const anchorX = view.getUint32(8);
  const anchorY = view.getUint32(12);
  const entryCount = view.getUint32(16);

  if (version !== TILE_BUNDLE_VERSION) {
    throw new Error(`Unsupported tile bundle version ${version}`);
  }
  if (flags !== 0) throw new Error(`Unsupported tile bundle flags ${flags}`);
  if (
    anchorZoom !== request.anchorZoom ||
    anchorX !== request.anchorX ||
    anchorY !== request.anchorY ||
    tileZoom !== request.tileZoom
  ) {
    throw new Error('Tile bundle header does not match the requested anchor and tile zoom');
  }

  const tiles = bundleTiles(request);
  if (entryCount !== tiles.length) {
    throw new Error(
      `Tile bundle entry count mismatch: expected ${tiles.length}, got ${entryCount}`
    );
  }

  const entries: TileBundleEntry[] = [];
  let offset = TILE_BUNDLE_HEADER_BYTES;
  for (const tile of tiles) {
    if (offset + 4 > bytes.byteLength) {
      throw new Error('Tile bundle ended before an entry length');
    }
    const length = view.getUint32(offset);
    offset += 4;
    if (length === EMPTY_TILE_LENGTH) {
      entries.push({ tile, bytes: null });
      continue;
    }
    if (offset + length > bytes.byteLength) {
      throw new Error('Tile bundle entry exceeds the response length');
    }
    entries.push({ tile, bytes: bytes.slice(offset, offset + length) });
    offset += length;
  }
  if (offset !== bytes.byteLength) throw new Error('Tile bundle has trailing bytes');
  return entries;
}

/**
 * HTTP client for the privacy-bundle endpoint hosted beside one Martin source.
 * The request exposes only the fixed anchor and requested data zoom.
 */
export class MartinTileBundleSource implements TileBundleSource {
  private readonly sourceUrl: string;

  constructor(sourceUrl: string) {
    this.sourceUrl = sourceUrl.replace(/\/+$/, '');
  }

  async getBundle(request: TileBundleRequest): Promise<readonly TileBundleEntry[]> {
    validateRequest(request);
    const url =
      `${this.sourceUrl}/bundle/v1/${request.anchorX}/${request.anchorY}/` + request.tileZoom;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TILE_BUNDLE_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: { Accept: TILE_BUNDLE_MEDIA_TYPE },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Tile bundle request failed: ${response.status} ${url}`);
      }
      const contentType = response.headers.get('content-type');
      if (!contentType?.toLowerCase().startsWith(TILE_BUNDLE_MEDIA_TYPE)) {
        throw new Error(
          `Tile bundle response has missing or unexpected content type: ${contentType ?? 'none'}`
        );
      }
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > TILE_BUNDLE_MAX_BYTES) {
        throw new Error(`Tile bundle exceeds the ${TILE_BUNDLE_MAX_BYTES}-byte limit`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > TILE_BUNDLE_MAX_BYTES) {
        throw new Error(`Tile bundle exceeds the ${TILE_BUNDLE_MAX_BYTES}-byte limit`);
      }
      return decodeTileBundle(bytes, request);
    } finally {
      clearTimeout(timer);
    }
  }
}

function validateRequest(request: TileBundleRequest): void {
  const { anchorZoom, anchorX, anchorY, tileZoom } = request;
  if (anchorZoom !== TILE_BUNDLE_ANCHOR_ZOOM) {
    throw new Error(`Tile bundle anchor zoom must be ${TILE_BUNDLE_ANCHOR_ZOOM}`);
  }
  if (!Number.isInteger(tileZoom) || tileZoom <= anchorZoom || tileZoom > TILE_BUNDLE_MAX_ZOOM) {
    throw new Error(
      `Tile bundle tile zoom must be between ${anchorZoom + 1} and ${TILE_BUNDLE_MAX_ZOOM}`
    );
  }
  const n = 2 ** anchorZoom;
  if (
    !Number.isInteger(anchorX) ||
    !Number.isInteger(anchorY) ||
    anchorX < 0 ||
    anchorY < 0 ||
    anchorX >= n ||
    anchorY >= n
  ) {
    throw new Error('Tile bundle anchor coordinates are out of range');
  }
}
