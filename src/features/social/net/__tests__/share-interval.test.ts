import { InMemoryKV } from '../background/persistent-kv';
import { DEFAULT_SHARE_INTERVAL_MS } from '../background/sampling-policy';
import {
  loadShareIntervalMs,
  saveShareIntervalMs,
  SHARE_INTERVAL_OPTIONS_MS,
} from '../persistence';

describe('share interval preference', () => {
  it('defaults to 5 minutes', async () => {
    expect(await loadShareIntervalMs(new InMemoryKV())).toBe(DEFAULT_SHARE_INTERVAL_MS);
  });

  it('round-trips every offered option', async () => {
    for (const option of SHARE_INTERVAL_OPTIONS_MS) {
      const kv = new InMemoryKV();
      await saveShareIntervalMs(kv, option);
      expect(await loadShareIntervalMs(kv)).toBe(option);
    }
  });

  // Off-grid intervals would break the wall-clock slot alignment the uniform cadence depends on,
  // so they are refused on the way in AND on the way out.
  it('refuses to persist a value outside the offered set', async () => {
    const kv = new InMemoryKV();
    await saveShareIntervalMs(kv, 300_000);
    await saveShareIntervalMs(kv, 37_000);

    expect(await loadShareIntervalMs(kv)).toBe(300_000);
  });

  it('falls back to the default when the stored value is corrupt', async () => {
    for (const corrupt of ['', 'nonsense', '0', '-1', '37000', 'NaN']) {
      const kv = new InMemoryKV();
      await kv.set('sc.social.shareIntervalMs', corrupt);
      expect(await loadShareIntervalMs(kv)).toBe(DEFAULT_SHARE_INTERVAL_MS);
    }
  });

  it('offers only intervals that divide the hour, keeping the slot grid aligned', () => {
    for (const option of SHARE_INTERVAL_OPTIONS_MS) {
      expect(3_600_000 % option).toBe(0);
    }
  });
});
