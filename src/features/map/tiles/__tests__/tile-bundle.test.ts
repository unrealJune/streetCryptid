import {
  bundleKeyOf,
  bundleRequestFor,
  bundleTiles,
  decodeTileBundle,
  MartinTileBundleSource,
  TILE_BUNDLE_MAX_BYTES,
  TILE_BUNDLE_MEDIA_TYPE,
  TILE_BUNDLE_VERSION,
  type TileBundleRequest,
} from '../tile-bundle';
import type { TileCoord } from '../tile-math';

const EMPTY_TILE_LENGTH = 0xffffffff;

function encodeBundle(
  request: TileBundleRequest,
  bytesFor: (tile: TileCoord) => Uint8Array | null
): Uint8Array {
  const entries = bundleTiles(request).map((tile) => bytesFor(tile));
  const size =
    20 + entries.reduce((total, bytes) => total + 4 + (bytes === null ? 0 : bytes.byteLength), 0);
  const out = new Uint8Array(size);
  out.set([0x53, 0x43, 0x42, 0x31], 0);
  const view = new DataView(out.buffer);
  view.setUint8(4, TILE_BUNDLE_VERSION);
  view.setUint8(5, request.anchorZoom);
  view.setUint8(6, request.tileZoom);
  view.setUint8(7, 0);
  view.setUint32(8, request.anchorX);
  view.setUint32(12, request.anchorY);
  view.setUint32(16, entries.length);
  let offset = 20;
  for (const bytes of entries) {
    view.setUint32(offset, bytes === null ? EMPTY_TILE_LENGTH : bytes.byteLength);
    offset += 4;
    if (bytes) {
      out.set(bytes, offset);
      offset += bytes.byteLength;
    }
  }
  return out;
}

const T14: TileCoord = { z: 14, x: 2625, y: 5723 };

describe('tile bundle addressing', () => {
  it('maps a z14 tile to its z10 anchor and all 256 descendants', () => {
    const request = bundleRequestFor(T14, 10);
    expect(request).toEqual({ anchorZoom: 10, anchorX: 164, anchorY: 357, tileZoom: 14 });
    expect(bundleKeyOf(request)).toBe('10/164/357@14');

    const tiles = bundleTiles(request);
    expect(tiles).toHaveLength(256);
    expect(tiles[0]).toEqual({ z: 14, x: 2624, y: 5712 });
    expect(tiles[255]).toEqual({ z: 14, x: 2639, y: 5727 });
    expect(tiles).toContainEqual(T14);
  });

  it('uses 64 descendants for the renderer’s normal z13 detail', () => {
    const request = bundleRequestFor({ z: 13, x: 1313, y: 2861 }, 10);
    expect(bundleTiles(request)).toHaveLength(64);
  });

  it('rejects bundle addressing at or below the privacy anchor', () => {
    expect(() => bundleRequestFor({ z: 10, x: 164, y: 357 }, 10)).toThrow('does not need');
    expect(() => bundleRequestFor(T14, 11)).toThrow('anchor zoom must be 10');
  });
});

describe('decodeTileBundle', () => {
  const request: TileBundleRequest = {
    anchorZoom: 10,
    anchorX: 164,
    anchorY: 357,
    tileZoom: 11,
  };

  it('decodes row-major MVT bytes and known-empty sentinels', () => {
    const bytes = encodeBundle(request, (tile) =>
      tile.x % 2 === 0 ? null : new Uint8Array([tile.x, tile.y])
    );
    const entries = decodeTileBundle(bytes, request);

    expect(entries).toHaveLength(4);
    expect(entries[0]).toEqual({ tile: { z: 11, x: 328, y: 714 }, bytes: null });
    expect(entries[1]).toEqual({
      tile: { z: 11, x: 329, y: 714 },
      bytes: new Uint8Array([329, 714]),
    });
  });

  it('rejects invalid magic, mismatched headers, truncation, and trailing bytes', () => {
    const valid = encodeBundle(request, () => null);

    const badMagic = valid.slice();
    badMagic[0] = 0;
    expect(() => decodeTileBundle(badMagic, request)).toThrow('invalid SCB1 magic');

    const wrongAnchor = valid.slice();
    new DataView(wrongAnchor.buffer).setUint32(8, request.anchorX + 1);
    expect(() => decodeTileBundle(wrongAnchor, request)).toThrow('does not match');

    expect(() => decodeTileBundle(valid.slice(0, -1), request)).toThrow(
      'ended before an entry length'
    );

    const trailing = new Uint8Array(valid.byteLength + 1);
    trailing.set(valid);
    expect(() => decodeTileBundle(trailing, request)).toThrow('trailing bytes');
  });

  it('rejects a declared entry count that is not the complete descendant set', () => {
    const bytes = encodeBundle(request, () => null);
    new DataView(bytes.buffer).setUint32(16, 3);
    expect(() => decodeTileBundle(bytes, request)).toThrow('entry count mismatch');
  });
});

describe('MartinTileBundleSource response guards', () => {
  const realFetch = global.fetch;
  const request = bundleRequestFor({ z: 11, x: 328, y: 714 }, 10);

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('rejects a missing bundle content type', async () => {
    global.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => encodeBundle(request, () => null).buffer,
      }) as unknown as Response) as typeof fetch;

    await expect(
      new MartinTileBundleSource('http://tiles.test').getBundle(request)
    ).rejects.toThrow('missing or unexpected content type');
  });

  it('rejects an oversized response before reading its body', async () => {
    let bodyRead = false;
    global.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'content-type'
              ? TILE_BUNDLE_MEDIA_TYPE
              : String(TILE_BUNDLE_MAX_BYTES + 1),
        },
        arrayBuffer: async () => {
          bodyRead = true;
          return new ArrayBuffer(0);
        },
      }) as unknown as Response) as typeof fetch;

    await expect(
      new MartinTileBundleSource('http://tiles.test').getBundle(request)
    ).rejects.toThrow('exceeds');
    expect(bodyRead).toBe(false);
  });
});
