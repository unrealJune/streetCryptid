import { createMapDataset, FIXTURE_DATA_ZOOMS, PLANET_DATA_ZOOMS } from '../config';
import { FIXTURE_BOUNDS, FIXTURE_HOME } from '../tiles/__fixtures__/caphill-tiles';
import type { TileBundleRequest } from '../tiles/tile-bundle';
import { WORLD_RECT } from '../tiles/tile-math';
import { TILE_STREAM_MEDIA_TYPE } from '../tiles/bundle-stream';
import { streamFixture } from '../tiles/__fixtures__/stream-fixture';

jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digest: async (_algorithm: string, bytes: ArrayBuffer) => {
    const { createHash } = jest.requireActual('node:crypto');
    return new Uint8Array(createHash('sha256').update(new Uint8Array(bytes)).digest()).buffer;
  },
}));
jest.mock('expo/fetch', () => ({
  fetch: (...args: Parameters<typeof fetch>) => global.fetch(...args),
}));
jest.mock('../tiles/bundle-resume-store', () => {
  const actual = jest.requireActual('../tiles/bundle-resume-store');
  return { ...actual, sharedBundleResumeStore: async () => new actual.MemoryBundleResumeStore() };
});

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
      const match = /\/bundle\/v2\/(\d+)\/(\d+)\/(\d+)$/.exec(url);
      if (match) {
        const request: TileBundleRequest = {
          anchorZoom: 10,
          anchorX: Number(match[1]),
          anchorY: Number(match[2]),
          tileZoom: Number(match[3]),
        };
        const bytes = streamFixture(request).all;
        let sent = false;
        return {
          status: 200,
          ok: true,
          headers: {
            get: (name: string) =>
              name === 'content-type'
                ? TILE_STREAM_MEDIA_TYPE
                : name === 'etag'
                  ? '"test-v2"'
                  : null,
          },
          body: {
            getReader: () => ({
              read: async () => {
                if (sent) return { done: true };
                sent = true;
                return { done: false, value: bytes };
              },
              cancel: async () => {},
            }),
          },
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
      'http://tiles.test/bundle/v2/164/357/13',
    ]);
    expect(requests[0].init?.headers).toEqual({ Accept: TILE_STREAM_MEDIA_TYPE });
  });

  it('a coarse tile uses the same planet source and passes through individually', async () => {
    const dataset = withTileUrl('http://tiles.test', createMapDataset);
    await dataset.source.getTile({ z: 4, x: 2, y: 5 });
    expect(requests.map((request) => request.url)).toEqual(['http://tiles.test/4/2/5']);
  });
});
