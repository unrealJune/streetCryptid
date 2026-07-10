import type { IncomingFix, LocationFix } from '../../../core/types';
import { createTrailStore, InMemoryTrailStorage, SELF_AUTHOR } from '../trail-store';

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
    expect(points).toEqual([{ author: 'friend-1', seq: 3, fix: fix(600), receivedAt: 1234 }]);
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

    expect(await store.removeAuthor('f')).toBe(2);
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
