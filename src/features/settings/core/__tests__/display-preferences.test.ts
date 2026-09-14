import { InMemoryKV } from '@/features/social/net/background/persistent-kv';

import { createDisplayPreferencesStore } from '../display-preferences';

describe('display preferences', () => {
  it('defaults to kilometers and hides friend connection details', async () => {
    const store = createDisplayPreferencesStore(new InMemoryKV());
    await store.load();
    expect(store.getSnapshot()).toEqual({
      distanceUnit: 'km',
      showFriendConnectionDetails: false,
      ready: true,
      error: null,
    });
  });

  it('persists both settings across a new store and notifies subscribers', async () => {
    const kv = new InMemoryKV();
    const store = createDisplayPreferencesStore(kv);
    const listener = jest.fn();
    const unsubscribe = store.subscribe(listener);
    await Promise.all([store.setDistanceUnit('mi'), store.setShowFriendConnectionDetails(true)]);
    const restored = createDisplayPreferencesStore(kv);
    await restored.load();
    expect(restored.getSnapshot()).toMatchObject({
      distanceUnit: 'mi',
      showFriendConnectionDetails: true,
    });
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    listener.mockClear();
    await store.setDistanceUnit('km');
    expect(listener).not.toHaveBeenCalled();
  });

  it.each(['invalid-json', '{"distanceUnit":"yards","showFriendConnectionDetails":"yes"}', 'null'])(
    'surfaces invalid stored data instead of silently displaying defaults: %s',
    async (raw) => {
      const kv = new InMemoryKV();
      await kv.set('sc.settings.display.v1', raw);
      const store = createDisplayPreferencesStore(kv);
      await store.load();
      expect(store.getSnapshot()).toMatchObject({
        ready: false,
        error: 'Could not load display preferences.',
      });
      await store.setDistanceUnit('mi');
      expect(await kv.get('sc.settings.display.v1')).toBe(raw);
    }
  );

  it('waits for hydration before applying an update', async () => {
    let resolveRead!: (value: string) => void;
    const store = createDisplayPreferencesStore({
      get: () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve;
        }),
      set: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn(),
    });
    const loaded = store.load();
    const updated = store.setDistanceUnit('mi');
    expect(store.getSnapshot().ready).toBe(false);
    resolveRead('{"distanceUnit":"km","showFriendConnectionDetails":true}');
    await Promise.all([loaded, updated]);
    expect(store.getSnapshot()).toMatchObject({
      distanceUnit: 'mi',
      showFriendConnectionDetails: true,
    });
  });

  it('does not claim a failed write was saved and allows retrying', async () => {
    const kv = new InMemoryKV();
    const store = createDisplayPreferencesStore(kv);
    const set = jest.spyOn(kv, 'set').mockRejectedValueOnce(new Error('full'));
    await store.setDistanceUnit('mi');
    expect(store.getSnapshot()).toMatchObject({ distanceUnit: 'km', error: expect.any(String) });
    await store.setDistanceUnit('mi');
    expect(store.getSnapshot()).toMatchObject({ distanceUnit: 'mi', error: null });
    expect(set).toHaveBeenCalledTimes(2);
  });

  it('does not overwrite unknown preferences when reading storage fails', async () => {
    const kv = new InMemoryKV();
    await kv.set('sc.settings.display.v1', '{"showFriendConnectionDetails":true}');
    const read = jest.spyOn(kv, 'get').mockRejectedValueOnce(new Error('busy'));
    const write = jest.spyOn(kv, 'set');
    const store = createDisplayPreferencesStore(kv);
    await store.setDistanceUnit('mi');
    expect(write).not.toHaveBeenCalled();
    expect(store.getSnapshot().error).toContain('load');
    expect(store.getSnapshot().ready).toBe(false);
    await store.setDistanceUnit('mi');
    expect(read).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toMatchObject({
      distanceUnit: 'mi',
      showFriendConnectionDetails: true,
      error: null,
    });
  });
});
