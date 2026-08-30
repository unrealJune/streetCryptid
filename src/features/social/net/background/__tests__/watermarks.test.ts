import { InMemoryKV } from '../fix-outbox';
import {
  loadWatermarks,
  stampWatermark,
  watermarkAges,
  WATERMARKS_KEY,
  type Watermarks,
} from '../watermarks';

describe('background watermarks', () => {
  it('round-trips a stamp', async () => {
    const kv = new InMemoryKV();
    await stampWatermark(kv, 'wake', 1_000);
    expect(await loadWatermarks(kv)).toEqual({ wake: 1_000 });
  });

  it('keeps every kind independent in the single shared row', async () => {
    const kv = new InMemoryKV();
    await stampWatermark(kv, 'wake', 1_000);
    await stampWatermark(kv, 'publish', 2_000);
    await stampWatermark(kv, 'push', 3_000);
    expect(await loadWatermarks(kv)).toEqual({ wake: 1_000, publish: 2_000, push: 3_000 });
  });

  it('tracks the periodic refresh separately from the location wake', async () => {
    // The two OS entry points fail independently and for different reasons — a phone whose
    // location task is spooling can still be running refreshes, and an iPhone can run location
    // updates for thirty hours without the refresh task firing once. One stamp for both would
    // report each as healthy whenever the other worked.
    const kv = new InMemoryKV();
    await stampWatermark(kv, 'wake', 1_000);
    await stampWatermark(kv, 'refresh', 4_000);
    expect(await loadWatermarks(kv)).toEqual({ wake: 1_000, refresh: 4_000 });
  });

  it('reads a never-stamped store as "nothing has ever happened"', async () => {
    expect(await loadWatermarks(new InMemoryKV())).toEqual({});
  });

  it('survives a corrupt row rather than throwing on the publish path', async () => {
    const kv = new InMemoryKV();
    await kv.set(WATERMARKS_KEY, '{not json');
    expect(await loadWatermarks(kv)).toEqual({});
    // And the next stamp repairs it.
    await stampWatermark(kv, 'fix', 42);
    expect(await loadWatermarks(kv)).toEqual({ fix: 42 });
  });

  it('ignores non-numeric values instead of exporting them as ages', async () => {
    const kv = new InMemoryKV();
    await kv.set(WATERMARKS_KEY, JSON.stringify({ wake: 'soon', publish: 5 }));
    expect(await loadWatermarks(kv)).toEqual({ publish: 5 });
  });

  it('never rejects when the store is broken — a missed stamp must not fail a publish', async () => {
    const broken = {
      get: async () => {
        throw new Error('db gone');
      },
      set: async () => {
        throw new Error('db gone');
      },
      remove: async () => {},
    };
    await expect(stampWatermark(broken, 'publish', 1)).resolves.toBeUndefined();
    await expect(loadWatermarks(broken)).resolves.toEqual({});
  });

  it('turns stamps into ages', () => {
    const marks: Watermarks = { wake: 9_000, publish: 5_000 };
    expect(watermarkAges(marks, 10_000)).toEqual({
      last_wake_age_ms: 1_000,
      last_publish_age_ms: 5_000,
    });
  });

  it('exports the refresh stamp as its own age attribute', () => {
    expect(watermarkAges({ refresh: 4_000 }, 10_000)).toEqual({ last_refresh_age_ms: 6_000 });
  });

  it('omits a kind that has never happened rather than sending a sentinel', () => {
    // "No last_publish_age_ms at all" and "published a long time ago" are different diagnoses;
    // a 0 or -1 would quietly collapse them into one.
    expect(watermarkAges({ wake: 1_000 }, 2_000)).toEqual({ last_wake_age_ms: 1_000 });
  });

  it('clamps a stamp from the future to zero rather than reporting a negative age', () => {
    // Clocks move backwards (NTP correction, a user changing the date), and a negative age would
    // render as a nonsense bar on every dashboard that plots it.
    expect(watermarkAges({ wake: 5_000 }, 1_000)).toEqual({ last_wake_age_ms: 0 });
  });
});
