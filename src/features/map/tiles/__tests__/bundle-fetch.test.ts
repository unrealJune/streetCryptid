import { BundleFetchByteSource } from '../bundle-fetch';
import {
  bundleRequestFor,
  type StreamStage,
  bundleTiles,
  MartinTileBundleSource,
  TILE_BUNDLE_MEDIA_TYPE,
  TILE_BUNDLE_VERSION,
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
  readonly deleted: string[] = [];

  async deleteSource(sourceId: string): Promise<void> {
    this.deleted.push(sourceId);
    for (const key of [...this.rows.keys()]) {
      if (key.startsWith(sourceId + '|')) this.rows.delete(key);
    }
  }

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
    retiredSourceIds: ['planet-z10-v0'],
    anchorZoom: 10,
    ttlMs: opts?.ttlMs ?? 1000,
    now: opts?.now ?? (() => 0),
  });
  return { coarse, bundles, store, source };
}

const T13: TileCoord = { z: 13, x: 1313, y: 2861 };

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function labelBytes(tile: TileCoord): Uint8Array {
  return new Uint8Array([0xee, tile.x % 251, tile.y % 251]);
}

/** An SCB3-shaped source: z13 overview, z14 structure, then resolves with z14 labels. */
class SplitBundleSource implements TileBundleSource {
  readonly requested: TileBundleRequest[] = [];
  gate: Promise<void> = Promise.resolve();

  async getBundle(
    request: TileBundleRequest,
    onStage?: Parameters<TileBundleSource['getBundle']>[1]
  ): Promise<readonly TileBundleEntry[]> {
    this.requested.push(request);
    if (request.tileZoom !== 14) {
      return bundleTiles(request).map((tile) => ({ tile, bytes: tagBytes(tile) }));
    }
    const overview = { ...request, tileZoom: 13 };
    await onStage?.(
      overview,
      bundleTiles(overview).map((tile) => ({ tile, bytes: tagBytes(tile) })),
      { tileZoom: 13, part: 'full' }
    );
    const structure = bundleTiles(request).map((tile) => ({ tile, bytes: tagBytes(tile) }));
    await onStage?.(request, structure, { tileZoom: 14, part: 'structure' });
    await this.gate;
    // Even columns carry no labels: an empty labels part is the empty sentinel.
    const labels = bundleTiles(request).map((tile) => ({
      tile,
      bytes: tile.x % 2 ? labelBytes(tile) : null,
    }));
    await onStage?.(request, labels, { tileZoom: 14, part: 'labels' });
    return labels;
  }
}
const T14: TileCoord = { z: 14, x: 2625, y: 5723 };

describe('BundleFetchByteSource — privacy contract', () => {
  it('shares one detail stream with its complete, durably stored coarse preview', async () => {
    let publish!: NonNullable<Parameters<TileBundleSource['getBundle']>[1]>;
    let finish!: (entries: readonly TileBundleEntry[]) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const bundles: TileBundleSource = {
      getBundle: (_request, onStage) => {
        publish = onStage!;
        started();
        return new Promise((r) => {
          finish = r;
        });
      },
    };
    let detailDone = false;
    const { source, store } = makeSource({ bundles });
    const previews: { stage: StreamStage; count: number }[] = [];
    const preview = source.getPreviewTiles([T14], async (stage, entries) => {
      previews.push({ stage, count: entries.length });
    });
    const detail = source.getTileBytes(T14).then((bytes) => {
      detailDone = true;
      return bytes;
    });
    await ready;
    const request = { ...bundleRequestFor(T14, 10), tileZoom: 13 };
    const entries = bundleTiles(request).map((tile) => ({ tile, bytes: tagBytes(tile) }));
    await publish(request, entries, { tileZoom: 13, part: 'full' });
    await flush();
    expect(previews).toEqual([{ stage: { tileZoom: 13, part: 'full' }, count: 1 }]);
    expect(store.lastPutSize).toBe(64);
    expect(detailDone).toBe(false);
    expect(await store.get('planet-z10-v1', entries[0].tile)).not.toBeNull();
    const detailRequest = bundleRequestFor(T14, 10);
    const full = bundleTiles(detailRequest).map((tile) => ({ tile, bytes: tagBytes(tile) }));
    await publish(detailRequest, full, { tileZoom: 14, part: 'full' });
    finish(full);
    expect(await detail).toEqual([tagBytes(T14)]);
    await preview;
    // A whole z14 stage has no structure preview; the detail itself is complete.
    expect(previews).toHaveLength(1);
    // Its labels row is written empty so the stored tile counts as complete.
    expect(await store.get('planet-z10-v1#labels', T14)).toEqual({ bytes: null, fetchedAt: 0 });
    expect(await source.getTileBytes(T14)).toEqual([tagBytes(T14)]);
  });

  it('turns one z13 tile miss into one complete z10 bundle request', async () => {
    const { coarse, bundles, store, source } = makeSource();

    expect(await source.getTileBytes(T13)).toEqual([tagBytes(T13)]);

    expect(coarse.requested).toEqual([]);
    expect((bundles as FakeBundleSource).requested).toEqual([bundleRequestFor(T13, 10)]);
    expect(store.putCount).toBe(1);
    expect(store.lastPutSize).toBe(64);
  });

  it('turns one z14 tile miss into one 256-entry z10 bundle request', async () => {
    const { bundles, store, source } = makeSource();

    expect(await source.getTileBytes(T14)).toEqual([tagBytes(T14)]);

    expect((bundles as FakeBundleSource).requested).toEqual([bundleRequestFor(T14, 10)]);
    expect(store.lastPutSize).toBe(256);
  });

  it('serves any warm sibling in the same bundle with zero network', async () => {
    const { coarse, bundles, source } = makeSource();
    await source.getTileBytes(T13);

    const sibling = { z: 13, x: 1319, y: 2856 };
    expect(await source.getTileBytes(sibling)).toEqual([tagBytes(sibling)]);
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

    expect(await source.getTileBytes(tile)).toEqual([tagBytes(tile)]);
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
    expect(await source.getTileBytes(T13)).toEqual([tagBytes(T13)]);
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
    await flush();

    expect(requested).toHaveLength(1);
    resolveBundle!(
      bundleTiles(requested[0]).map((tile) => ({
        tile,
        bytes: tagBytes(tile),
      }))
    );

    expect(await p1).toEqual([tagBytes(T13)]);
    expect(await p2).toEqual([tagBytes(sibling)]);
    expect(store.putCount).toBe(1);
  });

  it('releases a timed-out shared bundle for retry, serves stale offline, and ignores a late body', async () => {
    jest.useFakeTimers();
    const realFetch = global.fetch;
    try {
      const request = bundleRequestFor(T13, 10);
      const tiles = bundleTiles(request);
      const emptyBundle = new Uint8Array(20 + tiles.length * 4);
      emptyBundle.set([0x53, 0x43, 0x42, 0x31]);
      const view = new DataView(emptyBundle.buffer);
      view.setUint8(4, TILE_BUNDLE_VERSION);
      view.setUint8(5, request.anchorZoom);
      view.setUint8(6, request.tileZoom);
      view.setUint32(8, request.anchorX);
      view.setUint32(12, request.anchorY);
      view.setUint32(16, tiles.length);
      for (let offset = 20; offset < emptyBundle.length; offset += 4) {
        view.setUint32(offset, 0xffffffff);
      }
      let finishLateBody!: (bytes: ArrayBuffer) => void;
      const lateBody = new Promise<ArrayBuffer>((resolve) => {
        finishLateBody = resolve;
      });
      const response = {
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name === 'content-type' ? TILE_BUNDLE_MEDIA_TYPE : null),
        },
      };
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce({ ...response, arrayBuffer: () => lateBody })
        .mockResolvedValueOnce({
          ...response,
          arrayBuffer: async () => emptyBundle.buffer,
        });
      const { source, store, coarse } = makeSource({
        bundles: new MartinTileBundleSource('http://tiles.test'),
        ttlMs: 100,
        now: () => 200,
      });
      await store.putMany('planet-z10-v1', [{ tile: T13, bytes: tagBytes(T13) }], 0);
      const stale = source.getTileBytes(T13);
      const sibling = source.getTileBytes(tiles[0]).catch((error: Error) => error.name);

      await jest.advanceTimersByTimeAsync(60_000);
      expect(await stale).toEqual([tagBytes(T13)]);
      expect(await sibling).toBe('TimeoutError');
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(store.putCount).toBe(1);

      await expect(source.getTileBytes(T13)).resolves.toBeNull();
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(store.putCount).toBe(2);
      expect(store.lastPutSize).toBe(64);
      expect(coarse.requested).toEqual([]);
      expect(global.fetch).toHaveBeenLastCalledWith(
        'http://tiles.test/bundle/v1/164/357/13',
        expect.anything()
      );

      finishLateBody(emptyBundle.buffer);
      await jest.advanceTimersByTimeAsync(0);
      expect(store.putCount).toBe(2);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      global.fetch = realFetch;
      jest.useRealTimers();
    }
  });
});

describe('BundleFetchByteSource — split z14 stages (SCB3)', () => {
  it('stores structure and labels as two rows and serves both parts', async () => {
    const bundles = new SplitBundleSource();
    const { source, store } = makeSource({ bundles });

    expect(await source.getTileBytes(T14)).toEqual([tagBytes(T14), labelBytes(T14)]);
    const even = { ...T14, x: T14.x + 1 };
    expect(await source.getTileBytes(even)).toEqual([tagBytes(even)]);
    expect(await store.get('planet-z10-v1', T14)).toEqual({ bytes: tagBytes(T14), fetchedAt: 0 });
    expect(await store.get('planet-z10-v1#labels', T14)).toEqual({
      bytes: labelBytes(T14),
      fetchedAt: 0,
    });
    expect(bundles.requested).toHaveLength(1);
  });

  it('treats a z14 tile whose labels row is missing as a miss', async () => {
    const bundles = new SplitBundleSource();
    const { source, store } = makeSource({ bundles });
    await store.putMany('planet-z10-v1', [{ tile: T14, bytes: tagBytes(T14) }], 0);

    expect(await source.getTileBytes(T14)).toEqual([tagBytes(T14), labelBytes(T14)]);
    expect(bundles.requested).toHaveLength(1);
  });

  it('serves a structure-only copy offline when the labels never arrived', async () => {
    const bundles = new FakeBundleSource(tagBytes);
    bundles.failing = true;
    const { source, store } = makeSource({ bundles });
    await store.putMany('planet-z10-v1', [{ tile: T14, bytes: tagBytes(T14) }], 0);

    expect(await source.getTileBytes(T14)).toEqual([tagBytes(T14)]);
  });

  it('previews the z13 overview, then the z14 structure, before the labels land', async () => {
    const bundles = new SplitBundleSource();
    let release!: () => void;
    bundles.gate = new Promise((resolve) => {
      release = resolve;
    });
    const { source } = makeSource({ bundles });
    const stages: { stage: StreamStage; tiles: string[] }[] = [];
    const preview = source.getPreviewTiles([T14], async (stage, entries) => {
      stages.push({ stage, tiles: entries.map(({ tile }) => tileKeyOf(tile.z, tile.x, tile.y)) });
    });
    let detailDone = false;
    const detail = source.getTileBytes(T14).then((parts) => {
      detailDone = true;
      return parts;
    });
    await flush();
    expect(stages).toEqual([
      { stage: { tileZoom: 13, part: 'full' }, tiles: [tileKeyOf(13, T14.x >> 1, T14.y >> 1)] },
      { stage: { tileZoom: 14, part: 'structure' }, tiles: [tileKeyOf(14, T14.x, T14.y)] },
    ]);
    expect(detailDone).toBe(false);
    release();
    expect(await detail).toEqual([tagBytes(T14), labelBytes(T14)]);
    await preview;
    expect(stages).toHaveLength(2);
  });

  it('deletes retired namespaces once, without blocking reads', async () => {
    const store = new FakeStore();
    await store.putMany('planet-z10-v0', [{ tile: T13, bytes: tagBytes(T13) }], 0);
    const { source } = makeSource({ store });

    await source.getTileBytes(T13);
    await source.getTileBytes(T13);
    expect(store.deleted).toEqual(['planet-z10-v0']);
    expect(await store.get('planet-z10-v0', T13)).toBeNull();
  });
});
