import type { DeliveryDetail, IncomingFix, LocationFix } from '../../../core/types';
import {
  createTrailStore,
  InMemoryTrailStorage,
  mergeDelivery,
  SELF_AUTHOR,
  type TrailPoint,
} from '../trail-store';

function fix(ts: number, overrides: Partial<LocationFix> = {}): LocationFix {
  return { lat: 1, lon: 2, accuracyM: 5, headingDeg: 0, ts, ...overrides };
}

describe('trail store', () => {
  it('appendOwn stores under SELF_AUTHOR with receivedAt from now', async () => {
    const storage = new InMemoryTrailStorage();
    const store = createTrailStore({ storage, now: () => 1000 });
    await store.appendOwn(fix(500), 7);

    const points = await store.rangeFor(SELF_AUTHOR, 0);
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ author: SELF_AUTHOR, seq: 7, receivedAt: 1000 });
    expect(points[0].fix.ts).toBe(500);
  });

  it('appendFriend maps incoming fields', async () => {
    const storage = new InMemoryTrailStorage();
    const store = createTrailStore({ storage });
    const incoming: IncomingFix = {
      author: 'friend-1',
      seq: 3,
      fix: fix(600),
      receivedAt: 1234,
    };
    await store.appendFriend(incoming);

    const points = await store.rangeFor('friend-1', 0);
    expect(points).toEqual([
      { author: 'friend-1', seq: 3, fix: fix(600), receivedAt: 1234, via: 'live' },
    ]);
  });

  it('labels a backfilled fix as synced', async () => {
    const storage = new InMemoryTrailStorage();
    const store = createTrailStore({ storage });
    await store.appendFriend({ author: 'f', seq: 1, fix: fix(100), receivedAt: 0, backfill: true });

    expect((await store.rangeFor('f', 0)).map((p) => p.via)).toEqual(['sync']);
  });

  it('keeps only the newest fix per friend, with its own transport label', async () => {
    const storage = new InMemoryTrailStorage();
    const store = createTrailStore({ storage });
    await store.appendFriend({ author: 'f', seq: 1, fix: fix(100), receivedAt: 0, backfill: true });
    await store.appendFriend({ author: 'f', seq: 2, fix: fix(200), receivedAt: 0, via: 'relay' });

    // Friends' history is deliberately not retained, so the earlier `sync`-labelled fix is gone
    // rather than kept alongside. The survivor keeps the label it actually arrived with.
    const points = await store.rangeFor('f', 0);
    expect(points.map((p) => p.seq)).toEqual([2]);
    expect(points.map((p) => p.via)).toEqual(['relay']);
  });

  it('keeps the original provenance when a live fix is re-seen during sync', async () => {
    const storage = new InMemoryTrailStorage();
    const store = createTrailStore({ storage });
    await store.appendFriend({ author: 'f', seq: 1, fix: fix(100), receivedAt: 0, via: 'relay' });
    await store.appendFriend({ author: 'f', seq: 1, fix: fix(100), receivedAt: 5, backfill: true });

    const points = await store.rangeFor('f', 0);
    expect(points).toHaveLength(1);
    expect(points[0].via).toBe('relay');
    // Everything else still reflects the newer write.
    expect(points[0].receivedAt).toBe(5);
  });

  it('upgrades the coarse synced label when the serving peer is identified later', async () => {
    const storage = new InMemoryTrailStorage();
    const store = createTrailStore({ storage });
    // `refreshTrailFromReplica` re-reads the replica and can beat the backfill callback that
    // carries the precise label to the store.
    await store.appendFriend({ author: 'f', seq: 1, fix: fix(100), receivedAt: 0, backfill: true });
    await store.appendFriend({
      author: 'f',
      seq: 1,
      fix: fix(100),
      receivedAt: 1,
      backfill: true,
      via: 'stash',
    });

    expect((await store.rangeFor('f', 0))[0].via).toBe('stash');
  });

  it('adopts a provenance for rows stored before it was recorded', async () => {
    const storage = new InMemoryTrailStorage();
    await storage.put({ author: 'f', seq: 1, fix: fix(100), receivedAt: 0 });
    const store = createTrailStore({ storage });
    await store.appendFriend({ author: 'f', seq: 1, fix: fix(100), receivedAt: 1, via: 'stash' });

    expect((await store.rangeFor('f', 0))[0].via).toBe('stash');
  });

  it('leaves our own points unlabelled', async () => {
    const storage = new InMemoryTrailStorage();
    const store = createTrailStore({ storage });
    await store.appendOwn(fix(100), 1);

    expect((await store.rangeFor(SELF_AUTHOR, 0))[0].via).toBeUndefined();
  });

  it('appendFriend falls back to now() when receivedAt is missing', async () => {
    const storage = new InMemoryTrailStorage();
    const store = createTrailStore({ storage, now: () => 9999 });
    const incoming = {
      author: 'friend-2',
      seq: 1,
      fix: fix(100),
    } as unknown as IncomingFix;
    await store.appendFriend(incoming);

    const points = await store.rangeFor('friend-2', 0);
    expect(points[0].receivedAt).toBe(9999);
  });

  it('rangeFor filters by sinceTs and returns ascending by seq', async () => {
    const storage = new InMemoryTrailStorage();
    const store = createTrailStore({ storage });
    await store.appendOwn(fix(300), 3);
    await store.appendOwn(fix(100), 1);
    await store.appendOwn(fix(200), 2);

    const all = await store.rangeFor(SELF_AUTHOR, 0);
    expect(all.map((p) => p.seq)).toEqual([1, 2, 3]);

    const recent = await store.rangeFor(SELF_AUTHOR, 200);
    expect(recent.map((p) => p.seq)).toEqual([2, 3]);
  });

  it('latestPerAuthor returns newest per author by fix.ts', async () => {
    const storage = new InMemoryTrailStorage();
    const store = createTrailStore({ storage });
    await store.appendOwn(fix(100), 1);
    await store.appendOwn(fix(400), 2);
    await store.appendFriend({ author: 'f', seq: 1, fix: fix(200), receivedAt: 0 });
    await store.appendFriend({ author: 'f', seq: 2, fix: fix(150), receivedAt: 0 });

    const latest = await store.latestPerAuthor();
    const byAuthor = new Map(latest.map((p) => [p.author, p]));
    expect(byAuthor.get(SELF_AUTHOR)?.fix.ts).toBe(400);
    expect(byAuthor.get('f')?.fix.ts).toBe(200);
  });

  it('removes every cached point for one author', async () => {
    const storage = new InMemoryTrailStorage();
    const store = createTrailStore({ storage });
    await store.appendOwn(fix(100), 1);
    await store.appendFriend({ author: 'f', seq: 1, fix: fix(200), receivedAt: 0 });
    await store.appendFriend({ author: 'f', seq: 2, fix: fix(300), receivedAt: 0 });

    // Only the newest of the two friend fixes was ever kept.
    expect(await store.removeAuthor('f')).toBe(1);
    expect(await store.rangeFor('f', 0)).toEqual([]);
    expect(await store.rangeFor(SELF_AUTHOR, 0)).toHaveLength(1);
  });

  it('retains old points indefinitely unless explicitly pruned', async () => {
    const storage = new InMemoryTrailStorage();
    const store = createTrailStore({ storage, now: () => 5_000_000_000 });
    await store.appendOwn(fix(1), 1);
    await store.appendOwn(fix(2), 2);

    expect((await store.rangeFor(SELF_AUTHOR, 0)).map((p) => p.seq)).toEqual([1, 2]);
  });

  it('prune deletes points before an explicit threshold', async () => {
    const storage = new InMemoryTrailStorage();
    const store = createTrailStore({ storage, now: () => 0 });
    await store.appendOwn(fix(100), 1);
    await store.appendOwn(fix(200), 2);

    const removed = await store.prune(150);
    expect(removed).toBe(1);
    expect((await store.rangeFor(SELF_AUTHOR, 0)).map((p) => p.seq)).toEqual([2]);
  });

  it('upsert by (author, seq) does not duplicate', async () => {
    const storage = new InMemoryTrailStorage();
    const store = createTrailStore({ storage });
    await store.appendOwn(fix(100, { lat: 1 }), 5);
    await store.appendOwn(fix(100, { lat: 42 }), 5);

    const points = await store.rangeFor(SELF_AUTHOR, 0);
    expect(points).toHaveLength(1);
    expect(points[0].fix.lat).toBe(42);
  });
});

describe('mergeDelivery', () => {
  function detail(from: string): DeliveryDetail {
    return { via: 'relay', from, fromStash: false, paths: [] };
  }

  function point(overrides: Partial<TrailPoint>): TrailPoint {
    return { author: 'f', seq: 1, fix: fix(100), receivedAt: 0, ...overrides };
  }

  it('keeps the detail belonging to the write whose label won', () => {
    const existing = point({ via: 'relay', delivery: detail('winner') });
    const incoming = point({ via: 'sync', delivery: detail('loser') });
    expect(mergeDelivery(existing, incoming)?.from).toBe('winner');
  });

  it('hands the detail over when the incoming label takes the row', () => {
    const existing = point({ via: 'sync' });
    const incoming = point({ via: 'stash', delivery: detail('stash-peer') });
    expect(mergeDelivery(existing, incoming)?.from).toBe('stash-peer');
  });

  /** An older native core labels without detail; a later write of the SAME transport can fill it. */
  it('fills a missing detail from a write that agrees about the transport', () => {
    const existing = point({ via: 'relay' });
    const incoming = point({ via: 'relay', delivery: detail('late') });
    expect(mergeDelivery(existing, incoming)?.from).toBe('late');
  });

  /** The failure this guards: a relay label wearing a replica read's peer. */
  it('refuses detail from a write about a different transport', () => {
    const existing = point({ via: 'relay' });
    const incoming = point({ via: 'sync', delivery: detail('someone-else') });
    expect(mergeDelivery(existing, incoming)).toBeUndefined();
  });

  it('takes the incoming detail when the row had no label at all', () => {
    const existing = point({});
    const incoming = point({ via: 'lan', delivery: detail('first') });
    expect(mergeDelivery(existing, incoming)?.from).toBe('first');
  });
});

describe('trail store delivery detail', () => {
  const delivery: DeliveryDetail = {
    via: 'direct',
    from: 'peer-1',
    fromStash: false,
    paths: [{ kind: 'direct', address: '203.0.113.7:4433', active: true }],
  };

  it('stores the detail the native core supplied', async () => {
    const storage = new InMemoryTrailStorage();
    const store = createTrailStore({ storage });
    await store.appendFriend({
      author: 'f',
      seq: 1,
      fix: fix(100),
      receivedAt: 0,
      via: 'direct',
      delivery,
    });

    const points = await store.rangeFor('f', 0);
    expect(points[0].delivery).toEqual(delivery);
  });

  it('never invents detail for a fix that arrived without any', async () => {
    const storage = new InMemoryTrailStorage();
    const store = createTrailStore({ storage });
    await store.appendFriend({ author: 'f', seq: 1, fix: fix(100), receivedAt: 0 });

    const points = await store.rangeFor('f', 0);
    expect(points[0].via).toBe('live');
    expect(points[0].delivery).toBeUndefined();
  });

  /** A replica re-read must not strip the precise detail the live delivery already recorded. */
  it('keeps live detail when reconciliation re-sees the same fix', async () => {
    const storage = new InMemoryTrailStorage();
    const store = createTrailStore({ storage });
    await store.appendFriend({
      author: 'f',
      seq: 1,
      fix: fix(100),
      receivedAt: 0,
      via: 'direct',
      delivery,
    });
    await store.appendFriend({
      author: 'f',
      seq: 1,
      fix: fix(100),
      receivedAt: 1,
      backfill: true,
    });

    const points = await store.rangeFor('f', 0);
    expect(points[0].via).toBe('direct');
    expect(points[0].delivery).toEqual(delivery);
  });
});
