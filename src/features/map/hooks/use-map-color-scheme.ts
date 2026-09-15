import { useEffect, useSyncExternalStore } from 'react';
import { Appearance, AppState } from 'react-native';

import {
  getMapColorSchemeSnapshot,
  loadMapColorSchemePreference,
  refreshMaterialYouScheme,
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

  // The "System" scheme is the phone's wallpaper palette, and the OS can change it under a running
  // app without restarting the JS context. Neither of these is redundant: changing the wallpaper
  // fires nothing at all (hence the resume), and flipping the system theme repaints without the
  // app ever leaving the foreground (hence the appearance listener).
  useEffect(() => {
    const appearance = Appearance.addChangeListener(() => refreshMaterialYouScheme());
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshMaterialYouScheme();
    });
    return () => {
      appearance.remove();
      appState.remove();
    };
  }, []);

  return {
    ...snapshot,
    saveCustom: saveCustomMapColorScheme,
    select: selectMapColorScheme,
  };
}
