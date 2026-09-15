import { SymbolView } from 'expo-symbols';

import type { CryptidTheme } from '@/constants/cryptid-theme';

import { FAB_RADIUS, IslandPressable, islandStyles } from './glass-surface';

interface SettingsControlProps {
  readonly theme: CryptidTheme;
  onPress(): void;
}

/**
 * The app's only piece of top chrome. There is no tab bar and no header — Settings
 * is a sheet you pull over the map, so its entry point is a single island FAB
 * opposite the attribution line.
 *
 * Steel, never an accent: green belongs to friends and amber to YOU and the
 * frontier rim. Settings is not a signal — which is also why it passes no tint to
 * the glass.
 */
export function SettingsControl({ theme, onPress }: SettingsControlProps) {
  return (
    <IslandPressable
      accessibilityLabel="Settings"
      accessibilityRole="button"
      onPress={onPress}
      radius={FAB_RADIUS}
      style={islandStyles.fab}
      theme={theme}
    >
      <SymbolView
        name={{ ios: 'gearshape', android: 'settings', web: 'settings' }}
        size={21}
        tintColor={theme.chrome.steel}
      />
    </IslandPressable>
  );
}
