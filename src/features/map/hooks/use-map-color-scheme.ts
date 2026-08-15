import { useEffect, useSyncExternalStore } from 'react';

import {
  getMapColorSchemeSnapshot,
  loadMapColorSchemePreference,
  saveCustomMapColorScheme,
  selectMapColorScheme,
  subscribeToMapColorScheme,
} from '../theme/map-color-scheme-store';

export function useMapColorScheme() {
  const snapshot = useSyncExternalStore(
    subscribeToMapColorScheme,
    getMapColorSchemeSnapshot,
    getMapColorSchemeSnapshot
  );

  useEffect(() => {
    void loadMapColorSchemePreference();
  }, []);

  return {
    ...snapshot,
    saveCustom: saveCustomMapColorScheme,
    select: selectMapColorScheme,
  };
}
