import { InMemoryKV } from '../background/persistent-kv';
import { loadDeliveryMode, loadStashOptIn, saveDeliveryMode, saveStashOptIn } from '../persistence';

describe('delivery mode persistence', () => {
  it('defaults to direct on a fresh install', async () => {
    expect(await loadDeliveryMode(new InMemoryKV())).toBe('direct');
  });

  it('round-trips every route', async () => {
    for (const mode of ['direct', 'mutual', 'stash'] as const) {
      const kv = new InMemoryKV();
      await saveDeliveryMode(kv, mode);
      expect(await loadDeliveryMode(kv)).toBe(mode);
    }
  });

  describe('migration off the legacy boolean', () => {
    it('keeps an install that had offline delivery switched on', async () => {
      const kv = new InMemoryKV();
      await saveStashOptIn(kv, true);

      expect(await loadDeliveryMode(kv)).toBe('stash');
    });

    it('leaves an install that never opted in on direct', async () => {
      const kv = new InMemoryKV();
      await saveStashOptIn(kv, false);

      expect(await loadDeliveryMode(kv)).toBe('direct');
    });

    it('prefers an explicitly written mode over the legacy key', async () => {
      const kv = new InMemoryKV();
      await saveStashOptIn(kv, true);
      await saveDeliveryMode(kv, 'mutual');

      expect(await loadDeliveryMode(kv)).toBe('mutual');
    });
  });

  describe('the legacy mirror', () => {
    // A build that only understands the boolean still reads it. Leaving it stale would keep a
    // rolled-back install uploading to a stash the user had just moved off.
    it('is written on every save, in both directions', async () => {
      const kv = new InMemoryKV();

      await saveDeliveryMode(kv, 'stash');
      expect(await loadStashOptIn(kv)).toBe(true);

      await saveDeliveryMode(kv, 'direct');
      expect(await loadStashOptIn(kv)).toBe(false);

      await saveDeliveryMode(kv, 'mutual');
      expect(await loadStashOptIn(kv)).toBe(false);
    });
  });

  it('reads an unrecognised stored value as the default', async () => {
    const kv = new InMemoryKV();
    await kv.set('sc.social.deliveryMode', 'carrier-pigeon');

    expect(await loadDeliveryMode(kv)).toBe('direct');
  });
});
