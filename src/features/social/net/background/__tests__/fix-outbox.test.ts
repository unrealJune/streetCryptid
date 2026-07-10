import type { LocationFix } from '../../../core/types';
import { createFixOutbox, InMemoryKV } from '../fix-outbox';

/** ~111 m per 0.001° of longitude at the equator. */
function fixAt(lat: number, lon: number, ts = 0): LocationFix {
  return { lat, lon, accuracyM: 5, headingDeg: 0, ts };
}

describe('createFixOutbox', () => {
  it('appends fixes and reports pending', async () => {
    const kv = new InMemoryKV();
    const outbox = createFixOutbox({ kv, now: () => 1000 });
    await outbox.enqueue(fixAt(0, 0));
    await outbox.enqueue(fixAt(0, 0.001)); // ~111 m away → append
    expect(await outbox.pending()).toBe(2);
  });

  it('serializes concurrent captures so no fix is overwritten', async () => {
    const kv = new InMemoryKV();
    let clock = 0;
    const outbox = createFixOutbox({
      kv,
      coalesceDistanceM: 0,
      now: () => (clock += 10_000),
    });

    await Promise.all([
      outbox.enqueue(fixAt(0, 0, 1)),
      outbox.enqueue(fixAt(0, 0.001, 2)),
      outbox.enqueue(fixAt(0, 0.002, 3)),
    ]);

    const captured: number[] = [];
    await outbox.drain(async (item) => {
      captured.push(item.ts);
    });
    expect(captured).toEqual([1, 2, 3]);
  });

  it('coalesces a near + recent fix by replacing the last item', async () => {
    const kv = new InMemoryKV();
    let clock = 1000;
    const outbox = createFixOutbox({ kv, now: () => clock });
    await outbox.enqueue(fixAt(0, 0, 1));
    clock = 2000; // within 3000ms window
    await outbox.enqueue(fixAt(0, 0.00001, 2)); // ~1.1 m away → replace
    expect(await outbox.pending()).toBe(1);

    const published: LocationFix[] = [];
    await outbox.drain(async (f) => {
      published.push(f);
    });
    expect(published).toHaveLength(1);
    expect(published[0].ts).toBe(2); // the replacement, not the original
  });

  it('does not coalesce when outside the time window', async () => {
    const kv = new InMemoryKV();
    let clock = 1000;
    const outbox = createFixOutbox({ kv, now: () => clock });
    await outbox.enqueue(fixAt(0, 0));
    clock = 5000; // > 3000ms window
    await outbox.enqueue(fixAt(0, 0.00001));
    expect(await outbox.pending()).toBe(2);
  });

  it('evicts oldest items past maxItems', async () => {
    const kv = new InMemoryKV();
    let clock = 0;
    const outbox = createFixOutbox({ kv, maxItems: 2, now: () => (clock += 10_000) });
    await outbox.enqueue(fixAt(0, 0, 1));
    await outbox.enqueue(fixAt(0, 0.001, 2));
    await outbox.enqueue(fixAt(0, 0.002, 3));
    expect(await outbox.pending()).toBe(2);

    const published: LocationFix[] = [];
    await outbox.drain(async (f) => {
      published.push(f);
    });
    expect(published.map((f) => f.ts)).toEqual([2, 3]); // oldest (ts:1) dropped
  });

  it('drains in order and removes published items', async () => {
    const kv = new InMemoryKV();
    let clock = 0;
    const outbox = createFixOutbox({ kv, now: () => (clock += 10_000) });
    await outbox.enqueue(fixAt(0, 0, 1));
    await outbox.enqueue(fixAt(0, 0.001, 2));
    await outbox.enqueue(fixAt(0, 0.002, 3));

    const order: number[] = [];
    const count = await outbox.drain(async (f) => {
      order.push(f.ts);
    });
    expect(count).toBe(3);
    expect(order).toEqual([1, 2, 3]);
    expect(await outbox.pending()).toBe(0);
  });

  it('stops draining on throw and keeps the remainder', async () => {
    const kv = new InMemoryKV();
    let clock = 0;
    const outbox = createFixOutbox({ kv, now: () => (clock += 10_000) });
    await outbox.enqueue(fixAt(0, 0, 1));
    await outbox.enqueue(fixAt(0, 0.001, 2));
    await outbox.enqueue(fixAt(0, 0.002, 3));

    const count = await outbox.drain(async (f) => {
      if (f.ts === 2) throw new Error('publish failed');
    });
    expect(count).toBe(1);
    expect(await outbox.pending()).toBe(2); // ts:2 and ts:3 remain

    const order: number[] = [];
    await outbox.drain(async (f) => {
      order.push(f.ts);
    });
    expect(order).toEqual([2, 3]);
  });

  it('persists the queue across a fresh outbox over the same KV', async () => {
    const kv = new InMemoryKV();
    let clock = 0;
    const first = createFixOutbox({ kv, now: () => (clock += 10_000) });
    await first.enqueue(fixAt(0, 0, 1));
    await first.enqueue(fixAt(0, 0.001, 2));

    const second = createFixOutbox({ kv });
    expect(await second.pending()).toBe(2);

    const order: number[] = [];
    await second.drain(async (f) => {
      order.push(f.ts);
    });
    expect(order).toEqual([1, 2]);
  });

  it('respects a custom storageKey', async () => {
    const kv = new InMemoryKV();
    const outbox = createFixOutbox({ kv, storageKey: 'custom.key', now: () => 1 });
    await outbox.enqueue(fixAt(0, 0));
    expect(await kv.get('custom.key')).not.toBeNull();
    expect(await kv.get('sc.social.outbox')).toBeNull();
  });

  it('clears the queue', async () => {
    const kv = new InMemoryKV();
    const outbox = createFixOutbox({ kv, now: () => 1 });
    await outbox.enqueue(fixAt(0, 0));
    await outbox.clear();
    expect(await outbox.pending()).toBe(0);
  });
});
