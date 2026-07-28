import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet } from 'react-native';

import type { CryptidTheme } from '@/constants/cryptid-theme';

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
 * frontier rim. Settings is not a signal.
 */
export function SettingsControl({ theme, onPress }: SettingsControlProps) {
  const { chrome } = theme;

  return (
    <Pressable
      accessibilityLabel="Settings"
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.fab,
        {
          backgroundColor: chrome.island,
          borderColor: chrome.islandBorder,
          opacity: pressed ? 0.68 : 1,
        },
      ]}
    >
      <SymbolView
        name={{ ios: 'gearshape', android: 'settings', web: 'settings' }}
        size={21}
        tintColor={chrome.steel}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fab: {
    alignItems: 'center',
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
});
