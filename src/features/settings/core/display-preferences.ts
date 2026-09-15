import type { PersistentKV } from '@/features/social/net/background/persistent-kv';

import { isColorThemePreference, type ColorThemePreference } from './color-theme';
import type { DistanceUnit } from './distance-units';

const STORAGE_KEY = 'sc.settings.display.v1';

interface DisplayPreferences {
  readonly distanceUnit: DistanceUnit;
  readonly showFriendConnectionDetails: boolean;
  readonly colorTheme: ColorThemePreference;
}

const DEFAULTS: DisplayPreferences = {
  distanceUnit: 'km',
  showFriendConnectionDetails: false,
  colorTheme: 'system',
};

export interface DisplayPreferencesSnapshot extends DisplayPreferences {
  readonly ready: boolean;
  readonly error: string | null;
}

function readPreferences(raw: string | null): DisplayPreferences {
  if (raw === null) return DEFAULTS;
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid display preferences');
  }
  const distanceUnit = 'distanceUnit' in value ? value.distanceUnit : DEFAULTS.distanceUnit;
  const showFriendConnectionDetails =
    'showFriendConnectionDetails' in value
      ? value.showFriendConnectionDetails
      : DEFAULTS.showFriendConnectionDetails;
  // Absent is the norm, not a fault: every profile written before the theme picker existed has
  // no such key, and those phones are on `system` — which is exactly what they were doing.
  const colorTheme = 'colorTheme' in value ? value.colorTheme : DEFAULTS.colorTheme;
  if (
    (distanceUnit !== 'km' && distanceUnit !== 'mi') ||
    typeof showFriendConnectionDetails !== 'boolean' ||
    !isColorThemePreference(colorTheme)
  ) {
    throw new Error('Invalid display preferences');
  }
  return { distanceUnit, showFriendConnectionDetails, colorTheme };
}

/**
 * @param kv The backing store, or a thunk that builds one.
 *
 * The thunk is not a convenience. `colorTheme` lives here, `useColorScheme` reads it, and every
 * screen in the app reads THAT — so a KV built eagerly opens a SQLite database on the import path
 * of anything that paints itself, before the first frame. Built once, inside {@link load}, which
 * is already async and already off the render path.
 */
export function createDisplayPreferencesStore(kv: PersistentKV | (() => PersistentKV)) {
  let store: PersistentKV | null = typeof kv === 'function' ? null : kv;
  const backing = (): PersistentKV => (store ??= typeof kv === 'function' ? kv() : kv);
  let snapshot: DisplayPreferencesSnapshot = { ...DEFAULTS, ready: false, error: null };
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
        const raw = await backing().get(STORAGE_KEY);
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
        await backing().set(
          STORAGE_KEY,
          JSON.stringify({
            distanceUnit: next.distanceUnit,
            showFriendConnectionDetails: next.showFriendConnectionDetails,
            colorTheme: next.colorTheme,
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
    setColorTheme: (colorTheme: ColorThemePreference) => update({ colorTheme }),
  };
}
