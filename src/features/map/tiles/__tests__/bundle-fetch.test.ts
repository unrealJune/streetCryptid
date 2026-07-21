import { BundleFetchByteSource } from '../bundle-fetch';
import {
  bundleRequestFor,
  bundleTiles,
  type TileBundleEntry,
  type TileBundleRequest,
  type TileBundleSource,
} from '../tile-bundle';
import type { StoredTile, TileByteSource, TileByteStore } from '../tile-bytes';
import { tileKeyOf, type TileCoord } from '../tile-math';

class FakeCoarseSource implements TileByteSource {
  readonly requested: TileCoord[] = [];
  failing = false;

  constructor(private readonly bytesFor: (tile: TileCoord) => Uint8Array | null) {}

  async getTileBytes(tile: TileCoord): Promise<Uint8Array | null> {
    this.requested.push(tile);
    if (this.failing) throw new Error('network down');
    return this.bytesFor(tile);
  }
}

class FakeBundleSource implements TileBundleSource {
  readonly requested: TileBundleRequest[] = [];
  failing = false;

  constructor(private readonly bytesFor: (tile: TileCoord) => Uint8Array | null) {}

  async getBundle(request: TileBundleRequest): Promise<readonly TileBundleEntry[]> {
    this.requested.push(request);
    if (this.failing) throw new Error('network down');
    return bundleTiles(request).map((tile) => ({ tile, bytes: this.bytesFor(tile) }));
  }
}

class FakeStore implements TileByteStore {
  private readonly rows = new Map<string, StoredTile>();
  putCount = 0;
  lastPutSize = 0;

  async get(sourceId: string, tile: TileCoord): Promise<StoredTile | null> {
    return this.rows.get(sourceId + '|' + tileKeyOf(tile.z, tile.x, tile.y)) ?? null;
  }

  async putMany(
    sourceId: string,
    entries: readonly { tile: TileCoord; bytes: Uint8Array | null }[],
    fetchedAt: number
  ): Promise<void> {
    this.putCount++;
    this.lastPutSize = entries.length;
    for (const { tile, bytes } of entries) {
      this.rows.set(sourceId + '|' + tileKeyOf(tile.z, tile.x, tile.y), {
        bytes,
        fetchedAt,
      });
    }
  }
}

function tagBytes(tile: TileCoord): Uint8Array {
  return new Uint8Array([tile.z, tile.x % 251, tile.y % 251]);
}

function makeSource(opts?: {
  coarse?: FakeCoarseSource;
  bundles?: TileBundleSource;
  store?: FakeStore;
  ttlMs?: number;
  now?: () => number;
}) {
  const coarse = opts?.coarse ?? new FakeCoarseSource(tagBytes);
  const bundles = opts?.bundles ?? new FakeBundleSource(tagBytes);
  const store = opts?.store ?? new FakeStore();
  const source = new BundleFetchByteSource({
    coarseUpstream: coarse,
    bundleUpstream: bundles,
    store,
    sourceId: 'planet-z10-v1',
    anchorZoom: 10,
    ttlMs: opts?.ttlMs ?? 1000,
    now: opts?.now ?? (() => 0),
  });
  return { coarse, bundles, store, source };
}

const T13: TileCoord = { z: 13, x: 1313, y: 2861 };
const T14: TileCoord = { z: 14, x: 2625, y: 5723 };

describe('BundleFetchByteSource — privacy contract', () => {
  it('turns one z13 tile miss into one complete z10 bundle request', async () => {
    const { coarse, bundles, store, source } = makeSource();

    expect(await source.getTileBytes(T13)).toEqual(tagBytes(T13));

    expect(coarse.requested).toEqual([]);
    expect((bundles as FakeBundleSource).requested).toEqual([bundleRequestFor(T13, 10)]);
    expect(store.putCount).toBe(1);
    expect(store.lastPutSize).toBe(64);
  });

  it('turns one z14 tile miss into one 256-entry z10 bundle request', async () => {
    const { bundles, store, source } = makeSource();

    expect(await source.getTileBytes(T14)).toEqual(tagBytes(T14));

    expect((bundles as FakeBundleSource).requested).toEqual([bundleRequestFor(T14, 10)]);
    expect(store.lastPutSize).toBe(256);
  });

  it('serves any warm sibling in the same bundle with zero network', async () => {
    const { coarse, bundles, source } = makeSource();
    await source.getTileBytes(T13);

    const sibling = { z: 13, x: 1319, y: 2856 };
    expect(await source.getTileBytes(sibling)).toEqual(tagBytes(sibling));
    expect(coarse.requested).toEqual([]);
    expect((bundles as FakeBundleSource).requested).toHaveLength(1);
  });

  it('persists empty descendants so they are not re-probed', async () => {
    const bundles = new FakeBundleSource((tile) => (tile.x % 2 === 0 ? null : tagBytes(tile)));
    const { source } = makeSource({ bundles });

    await source.getTileBytes(T13);
    expect(await source.getTileBytes({ z: 13, x: 1312, y: 2856 })).toBeNull();
    expect(bundles.requested).toHaveLength(1);
  });

  it('uses ordinary single-tile requests at or below z10', async () => {
    const { coarse, bundles, store, source } = makeSource();
    const tile = { z: 10, x: 164, y: 357 };

    expect(await source.getTileBytes(tile)).toEqual(tagBytes(tile));
    expect(coarse.requested).toEqual([tile]);
    expect((bundles as FakeBundleSource).requested).toEqual([]);
    expect(store.lastPutSize).toBe(1);
  });

  it('rejects an incomplete bundle instead of persisting a privacy-shaped success', async () => {
    const bundles: TileBundleSource = {
      getBundle: async (request) =>
        bundleTiles(request)
          .slice(1)
          .map((tile) => ({ tile, bytes: tagBytes(tile) })),
    };
    const { source, store } = makeSource({ bundles });

    await expect(source.getTileBytes(T13)).rejects.toThrow('entry count mismatch');
    expect(store.putCount).toBe(0);
  });
});

describe('BundleFetchByteSource — TTL and failure', () => {
  it('refetches the entire bundle when the requested tile is stale', async () => {
    let now = 0;
    const { bundles, source } = makeSource({ ttlMs: 100, now: () => now });

    await source.getTileBytes(T13);
    expect((bundles as FakeBundleSource).requested).toHaveLength(1);

    now = 50;
    await source.getTileBytes(T13);
    expect((bundles as FakeBundleSource).requested).toHaveLength(1);

    now = 200;
    await source.getTileBytes(T13);
    expect((bundles as FakeBundleSource).requested).toHaveLength(2);
  });

  it('serves stale bytes when a bundle refresh fails', async () => {
    let now = 0;
    const bundles = new FakeBundleSource(tagBytes);
    const { source } = makeSource({ bundles, ttlMs: 100, now: () => now });
    await source.getTileBytes(T13);

    now = 200;
    bundles.failing = true;
    expect(await source.getTileBytes(T13)).toEqual(tagBytes(T13));
  });

  it('rejects a bundle failure when nothing is stored', async () => {
    const bundles = new FakeBundleSource(tagBytes);
    bundles.failing = true;
    const { source } = makeSource({ bundles });

    await expect(source.getTileBytes(T13)).rejects.toThrow('network down');
  });
});

describe('BundleFetchByteSource — in-flight dedup', () => {
  it('concurrent child requests in one z10 bundle share one HTTP bundle fetch', async () => {
    let resolveBundle: ((entries: readonly TileBundleEntry[]) => void) | undefined;
    const requested: TileBundleRequest[] = [];
    const bundles: TileBundleSource = {
      getBundle: (request) => {
        requested.push(request);
        return new Promise((resolve) => {
          resolveBundle = resolve;
        });
      },
    };
    const store = new FakeStore();
    const { source } = makeSource({ bundles, store });

    const p1 = source.getTileBytes(T13);
    const sibling = { z: 13, x: 1319, y: 2856 };
    const p2 = source.getTileBytes(sibling);
    await Promise.resolve();
    await Promise.resolve();

    expect(requested).toHaveLength(1);
    resolveBundle!(
      bundleTiles(requested[0]).map((tile) => ({
        tile,
        bytes: tagBytes(tile),
      }))
    );

    expect(await p1).toEqual(tagBytes(T13));
    expect(await p2).toEqual(tagBytes(sibling));
    expect(store.putCount).toBe(1);
  });
});
