import { createMapDataset, FIXTURE_DATA_ZOOMS, PLANET_DATA_ZOOMS } from '../config';
import { FIXTURE_BOUNDS, FIXTURE_HOME } from '../tiles/__fixtures__/caphill-tiles';
import {
  bundleTiles,
  TILE_BUNDLE_MEDIA_TYPE,
  TILE_BUNDLE_VERSION,
  type TileBundleRequest,
} from '../tiles/tile-bundle';
import { WORLD_RECT } from '../tiles/tile-math';

function withTileUrl<T>(value: string | undefined, fn: () => T): T {
  const original = process.env.EXPO_PUBLIC_TILE_URL;
  if (value === undefined) delete process.env.EXPO_PUBLIC_TILE_URL;
  else process.env.EXPO_PUBLIC_TILE_URL = value;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.EXPO_PUBLIC_TILE_URL;
    else process.env.EXPO_PUBLIC_TILE_URL = original;
  }
}

describe('createMapDataset', () => {
  it('without EXPO_PUBLIC_TILE_URL uses the bundled fixture world with demo exploration', () => {
    const dataset = withTileUrl(undefined, createMapDataset);
    expect(dataset.bounds).toBe(FIXTURE_BOUNDS);
    expect(dataset.home).toBe(FIXTURE_HOME);
    expect(dataset.explorationMode).toBe('demo');
    expect(dataset.minZoom).toBe(11);
    expect(dataset.dataZooms).toBe(FIXTURE_DATA_ZOOMS);
  });

  it('with EXPO_PUBLIC_TILE_URL opens one world dataset from z0 through z14', () => {
    const dataset = withTileUrl('http://tiles.test', createMapDataset);
    expect(dataset.bounds).toBe(WORLD_RECT);
    expect(dataset.minZoom).toBe(1);
    expect(dataset.explorationMode).toBe('live');
    expect(dataset.dataZooms).toBe(PLANET_DATA_ZOOMS);
    // Seattle home sits inside the pan bounds.
    expect(dataset.home[0]).toBeGreaterThan(dataset.bounds.minX);
    expect(dataset.home[0]).toBeLessThan(dataset.bounds.maxX);
    expect(dataset.home[1]).toBeGreaterThan(dataset.bounds.minY);
    expect(dataset.home[1]).toBeLessThan(dataset.bounds.maxY);
  });
});

describe('createMapDataset — live chain request shape', () => {
  const realFetch = global.fetch;
  let requests: { url: string; init?: RequestInit }[] = [];

  beforeEach(() => {
    requests = [];
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      const match = /\/bundle\/v1\/(\d+)\/(\d+)\/(\d+)$/.exec(url);
      if (match) {
        const request: TileBundleRequest = {
          anchorZoom: 10,
          anchorX: Number(match[1]),
          anchorY: Number(match[2]),
          tileZoom: Number(match[3]),
        };
        const bytes = emptyBundle(request);
        return {
          status: 200,
          ok: true,
          headers: { get: () => TILE_BUNDLE_MEDIA_TYPE },
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        } as unknown as Response;
      }
      return { status: 204, ok: false } as Response;
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('one fine tile request exposes only one z10 bundle URL', async () => {
    const dataset = withTileUrl('http://tiles.test', createMapDataset);
    await dataset.source.getTile({ z: 13, x: 1313, y: 2861 });

    expect(requests.map((request) => request.url)).toEqual([
      'http://tiles.test/bundle/v1/164/357/13',
    ]);
    expect(requests[0].init?.headers).toEqual({ Accept: TILE_BUNDLE_MEDIA_TYPE });
  });

  it('a coarse tile uses the same planet source and passes through individually', async () => {
    const dataset = withTileUrl('http://tiles.test', createMapDataset);
    await dataset.source.getTile({ z: 4, x: 2, y: 5 });
    expect(requests.map((request) => request.url)).toEqual(['http://tiles.test/4/2/5']);
  });
});

function emptyBundle(request: TileBundleRequest): Uint8Array {
  const count = bundleTiles(request).length;
  const bytes = new Uint8Array(20 + count * 4);
  bytes.set([0x53, 0x43, 0x42, 0x31]);
  const view = new DataView(bytes.buffer);
  view.setUint8(4, TILE_BUNDLE_VERSION);
  view.setUint8(5, request.anchorZoom);
  view.setUint8(6, request.tileZoom);
  view.setUint8(7, 0);
  view.setUint32(8, request.anchorX);
  view.setUint32(12, request.anchorY);
  view.setUint32(16, count);
  for (let offset = 20; offset < bytes.byteLength; offset += 4) {
    view.setUint32(offset, 0xffffffff);
  }
  return bytes;
}
