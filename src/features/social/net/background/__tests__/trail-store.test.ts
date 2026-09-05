import type { IncomingFix, LocationFix } from '../../../core/types';
import { createTrailStore, InMemoryTrailStorage, SELF_AUTHOR } from '../trail-store';

function fix(ts: number, overrides: Partial<LocationFix> = {}): LocationFix {
  return { lat: 1, lon: 2, accuracyM: 5, headingDeg: 0, ts, ...overrides };
}

/** A friend's single stored fix, or undefined when we hold none for them. */
async function friend(store: ReturnType<typeof createTrailStore>, author: string) {
  return (await store.friendLatest()).find((point) => point.author === author);
}

describe('trail store', () => {
  it('appendOwn stores under SELF_AUTHOR with receivedAt from now', async () => {
    const storage = new InMemoryTrailStorage();
    const store = createTrailStore({ storage, now: () => 1000 });
    await store.appendOwn(fix(500), 7);

    const points = await store.selfTrail();
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ author: SELF_AUTHOR, seq: 7, receivedAt: 1000 });
    expect(points[0].fix.ts).toBe(500);
  });

  it('recordFriendLatest maps incoming fields', async () => {
    const storage = new InMemoryTrailStorage();
    const store = createTrailStore({ storage });
    const incoming: IncomingFix = {
      author: 'friend-1',
      seq: 3,
      fix: fix(600),
      receivedAt: 1234,
    };
    await store.recordFriendLatest(incoming);

    expect(await store.friendLatest()).toEqual([
      { author: 'friend-1', seq: 3, fix: fix(600), receivedAt: 1234, via: 'live' },
    ]);
  });

  it('labels a backfilled fix as synced', async () => {
    const storage = new InMemoryTrailStorage();
    const store = createTrailStore({ storage });
    await store.recordFriendLatest({
      author: 'f',
      seq: 1,
      fix: fix(100),
      receivedAt: 0,
      backfill: true,
    });

    expect((await friend(store, 'f'))?.via).toBe('sync');
  });

  it('keeps only the newest fix per friend, with its own transport label', async () => {
    const storage = new InMemoryTrailStorage();
    const store = createTrailStore({ storage });
    await store.recordFriendLatest({
      author: 'f',
      seq: 1,
      fix: fix(100),
      receivedAt: 0,
      backfill: true,
    });
    await store.recordFriendLatest({
      author: 'f',
      seq: 2,
      fix: fix(200),
      receivedAt: 0,
      via: 'relay',
    });

    // Friends' history is deliberately not retained, so the earlier `sync`-labelled fix is gone
    // rather than kept alongside. The survivor keeps the label it actually arrived with.
    const points = await store.friendLatest();
    expect(points.map((p) => p.seq)).toEqual([2]);
    expect(points.map((p) => p.via)).toEqual(['relay']);
  });

  it('does not move a friend backwards when an older fix arrives late', async () => {
    const storage = new InMemoryTrailStorage();
    const store = createTrailStore({ storage });
    await store.recordFriendLatest({ author: 'f', seq: 2, fix: fix(200), receivedAt: 0 });
    // Reconciliation routinely delivers old entries after new ones.
    await store.recordFriendLatest({ author: 'f', seq: 1, fix: fix(100), receivedAt: 1 });

    const held = await friend(store, 'f');
    expect(held?.seq).toBe(2);
    expect(held?.fix.ts).toBe(200);
  });

  it('breaks a fix.ts tie by seq rather than by arrival order', async () => {
    const storage = new InMemoryTrailStorage();
    const store = createTrailStore({ storage });
    await store.recordFriendLatest({ author: 'f', seq: 9, fix: fix(100), receivedAt: 0 });
    await store.recordFriendLatest({ author: 'f', seq: 4, fix: fix(100), receivedAt: 1 });

    expect((await friend(store, 'f'))?.seq).toBe(9);
  });

  it('keeps the original provenance when a live fix is re-seen during sync', async () => {
    const storage = new InMemoryTrailStorage();
    const store = createTrailStore({ storage });
    await store.recordFriendLatest({
      author: 'f',
      seq: 1,
      fix: fix(100),
      receivedAt: 0,
      via: 'relay',
    });
    await store.recordFriendLatest({
      author: 'f',
      seq: 1,
      fix: fix(100),
      receivedAt: 5,
      backfill: true,
    });

    const held = await friend(store, 'f');
    expect(held?.via).toBe('relay');
    // Everything else still reflects the newer write.
    expect(held?.receivedAt).toBe(5);
  });

  it('upgrades the coarse synced label when the serving peer is identified later', async () => {
    const storage = new InMemoryTrailStorage();
    const store = createTrailStore({ storage });
    // `refreshTrailFromReplica` re-reads the replica and can beat the backfill callback that
    // carries the precise label to the store.
    await store.recordFriendLatest({
      author: 'f',
      seq: 1,
      fix: fix(100),
      receivedAt: 0,
      backfill: true,
    });
    await store.recordFriendLatest({
      author: 'f',
      seq: 1,
      fix: fix(100),
      receivedAt: 1,
      backfill: true,
      via: 'stash',
    });

    expect((await friend(store, 'f'))?.via).toBe('stash');
  });

  it('adopts a provenance for rows stored before it was recorded', async () => {
    const storage = new InMemoryTrailStorage();
    await storage.putFriendLatest({ author: 'f', seq: 1, fix: fix(100), receivedAt: 0 });
    const store = createTrailStore({ storage });
    await store.recordFriendLatest({
      author: 'f',
      seq: 1,
      fix: fix(100),
      receivedAt: 1,
      via: 'stash',
    });

    expect((await friend(store, 'f'))?.via).toBe('stash');
  });

  it('keeps the transport label and the deliverer as one record', async () => {
    const storage = new InMemoryTrailStorage();
    const store = createTrailStore({ storage });
    await store.recordFriendLatest({
      author: 'f',
      seq: 1,
      fix: fix(100),
      receivedAt: 0,
      via: 'relay',
      viaPeer: 'aa'.repeat(32),
    });
    // A later re-read of the replica names a different peer. Taking it would pair a reconciliation
    // peer with a live label and describe a delivery that never happened.
    await store.recordFriendLatest({
      author: 'f',
      seq: 1,
      fix: fix(100),
      receivedAt: 5,
      backfill: true,
      via: 'docs',
      viaPeer: 'bb'.repeat(32),
    });

    const held = await friend(store, 'f');
    expect(held?.via).toBe('relay');
    expect(held?.viaPeer).toBe('aa'.repeat(32));
  });

  it('takes the whole record when an unresolved label is sharpened', async () => {
    const storage = new InMemoryTrailStorage();
    const store = createTrailStore({ storage });
    await store.recordFriendLatest({
      author: 'f',
      seq: 1,
      fix: fix(100),
      receivedAt: 0,
      backfill: true,
    });
    await store.recordFriendLatest({
      author: 'f',
      seq: 1,
      fix: fix(100),
      receivedAt: 1,
      backfill: true,
      via: 'docs',
      viaPeer: 'cc'.repeat(32),
    });

    const held = await friend(store, 'f');
    expect(held?.via).toBe('docs');
    expect(held?.viaPeer).toBe('cc'.repeat(32));
  });

  it('lets a strictly newer fix bring its own deliverer', async () => {
    const storage = new InMemoryTrailStorage();
    const store = createTrailStore({ storage });
    await store.recordFriendLatest({
      author: 'f',
      seq: 1,
      fix: fix(100),
      receivedAt: 0,
      via: 'relay',
      viaPeer: 'aa'.repeat(32),
    });
    await store.recordFriendLatest({
      author: 'f',
      seq: 2,
      fix: fix(200),
      receivedAt: 1,
      via: 'lan',
      viaPeer: 'bb'.repeat(32),
    });

    const held = await friend(store, 'f');
    expect(held?.via).toBe('lan');
    expect(held?.viaPeer).toBe('bb'.repeat(32));
  });

  it('leaves our own points unlabelled', async () => {
    const storage = new InMemoryTrailStorage();
    const store = createTrailStore({ storage });
    await store.appendOwn(fix(100), 1);

    expect((await store.selfTrail())[0].via).toBeUndefined();
  });

  it('recordFriendLatest falls back to now() when receivedAt is missing', async () => {
    const storage = new InMemoryTrailStorage();
    const store = createTrailStore({ storage, now: () => 9999 });
    const incoming = {
      author: 'friend-2',
      seq: 1,
      fix: fix(100),
    } as unknown as IncomingFix;
    await store.recordFriendLatest(incoming);

    expect((await friend(store, 'friend-2'))?.receivedAt).toBe(9999);
  });

  it('selfTrail filters by sinceTs and returns ascending by seq', async () => {
    const storage = new InMemoryTrailStorage();
    const store = createTrailStore({ storage });
    await store.appendOwn(fix(300), 3);
    await store.appendOwn(fix(100), 1);
    await store.appendOwn(fix(200), 2);

    expect((await store.selfTrail()).map((p) => p.seq)).toEqual([1, 2, 3]);
    expect((await store.selfTrail(200)).map((p) => p.seq)).toEqual([2, 3]);
  });

  it('keeps our own history and only the current fix per friend', async () => {
    const storage = new InMemoryTrailStorage();
    const store = createTrailStore({ storage });
    await store.appendOwn(fix(100), 1);
    await store.appendOwn(fix(400), 2);
    await store.recordFriendLatest({ author: 'f', seq: 1, fix: fix(200), receivedAt: 0 });
    await store.recordFriendLatest({ author: 'f', seq: 2, fix: fix(150), receivedAt: 0 });

    // Our own trail is history; a friend is one dot. The late fix(150) is older than fix(200),
    // so it does not displace it.
    expect((await store.selfTrail()).map((p) => p.fix.ts)).toEqual([100, 400]);
    expect((await store.friendLatest()).map((p) => p.fix.ts)).toEqual([200]);
  });

  it('removeFriend drops their fix and leaves our own trail alone', async () => {
    const storage = new InMemoryTrailStorage();
    const store = createTrailStore({ storage });
    await store.appendOwn(fix(100), 1);
    await store.recordFriendLatest({ author: 'f', seq: 1, fix: fix(200), receivedAt: 0 });
    await store.recordFriendLatest({ author: 'f', seq: 2, fix: fix(300), receivedAt: 0 });

    // Only the newest of the two friend fixes was ever kept.
    expect(await store.removeFriend('f')).toBe(1);
    expect(await store.friendLatest()).toEqual([]);
    expect(await store.selfTrail()).toHaveLength(1);
  });

  it('retains old points indefinitely unless explicitly pruned', async () => {
    const storage = new InMemoryTrailStorage();
    const store = createTrailStore({ storage, now: () => 5_000_000_000 });
    await store.appendOwn(fix(1), 1);
    await store.appendOwn(fix(2), 2);

    expect((await store.selfTrail()).map((p) => p.seq)).toEqual([1, 2]);
  });

  it('pruneSelf deletes points before an explicit threshold', async () => {
    const storage = new InMemoryTrailStorage();
    const store = createTrailStore({ storage, now: () => 0 });
    await store.appendOwn(fix(100), 1);
    await store.appendOwn(fix(200), 2);

    expect(await store.pruneSelf(150)).toBe(1);
    expect((await store.selfTrail()).map((p) => p.seq)).toEqual([2]);
  });

  it('upsert by seq does not duplicate our own points', async () => {
    const storage = new InMemoryTrailStorage();
    const store = createTrailStore({ storage });
    await store.appendOwn(fix(100, { lat: 1 }), 5);
    await store.appendOwn(fix(100, { lat: 42 }), 5);

    const points = await store.selfTrail();
    expect(points).toHaveLength(1);
    expect(points[0].fix.lat).toBe(42);
  });
});
