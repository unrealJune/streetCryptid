import type { PersistentKV } from '@/features/social/net/background/persistent-kv';

import type { DistanceUnit } from './distance-units';

const STORAGE_KEY = 'sc.settings.display.v1';

interface DisplayPreferences {
  readonly distanceUnit: DistanceUnit;
  readonly showFriendConnectionDetails: boolean;
}

export interface DisplayPreferencesSnapshot extends DisplayPreferences {
  readonly ready: boolean;
  readonly error: string | null;
}

function readPreferences(raw: string | null): DisplayPreferences {
  if (raw === null) return { distanceUnit: 'km', showFriendConnectionDetails: false };
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid display preferences');
  }
  const distanceUnit = 'distanceUnit' in value ? value.distanceUnit : 'km';
  const showFriendConnectionDetails =
    'showFriendConnectionDetails' in value ? value.showFriendConnectionDetails : false;
  if (
    (distanceUnit !== 'km' && distanceUnit !== 'mi') ||
    typeof showFriendConnectionDetails !== 'boolean'
  ) {
    throw new Error('Invalid display preferences');
  }
  return { distanceUnit, showFriendConnectionDetails };
}

export function createDisplayPreferencesStore(kv: PersistentKV) {
  let snapshot: DisplayPreferencesSnapshot = {
    distanceUnit: 'km',
    showFriendConnectionDetails: false,
    ready: false,
    error: null,
  };
  let loadPromise: Promise<void> | null = null;
  let loaded = false;
  let writes = Promise.resolve();
  const listeners = new Set<() => void>();

  const emit = (next: DisplayPreferencesSnapshot) => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };

  const load = (): Promise<void> => {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      try {
        const raw = await kv.get(STORAGE_KEY);
        const saved = readPreferences(raw);
        loaded = true;
        emit({
          ...saved,
          ready: true,
          error: null,
        });
      } catch {
        loadPromise = null;
        emit({ ...snapshot, ready: false, error: 'Could not load display preferences.' });
      }
    })();
    return loadPromise;
  };

  const update = (change: Partial<DisplayPreferences>): Promise<void> => {
    writes = writes.then(async () => {
      await load();
      if (!loaded) return;
      const next = { ...snapshot, ...change, error: null };
      try {
        await kv.set(
          STORAGE_KEY,
          JSON.stringify({
            distanceUnit: next.distanceUnit,
            showFriendConnectionDetails: next.showFriendConnectionDetails,
          })
        );
        emit(next);
      } catch {
        emit({ ...snapshot, error: 'Could not save display preferences. Try again.' });
      }
    });
    return writes;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load,
    setDistanceUnit: (distanceUnit: DistanceUnit) => update({ distanceUnit }),
    setShowFriendConnectionDetails: (showFriendConnectionDetails: boolean) =>
      update({ showFriendConnectionDetails }),
  };
}
