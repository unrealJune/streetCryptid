import { useEffect, useSyncExternalStore } from 'react';

import { createPersistentKV } from '@/features/social/net/persistence';

import { createDisplayPreferencesStore } from '../core/display-preferences';

const store = createDisplayPreferencesStore(createPersistentKV());

export function useDisplayPreferences() {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => {
    void store.load();
  }, []);
  return {
    ...snapshot,
    reload: store.load,
    setDistanceUnit: store.setDistanceUnit,
    setShowFriendConnectionDetails: store.setShowFriendConnectionDetails,
  };
}
