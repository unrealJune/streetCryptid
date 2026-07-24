import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet } from 'react-native';

import type { CryptidTheme } from '@/constants/cryptid-theme';

interface LocateMeControlProps {
  readonly disabled: boolean;
  readonly theme: CryptidTheme;
  onPress(): void;
}

/** Recenter the map on the latest available self location. */
export function LocateMeControl({ disabled, theme, onPress }: LocateMeControlProps) {
  const { chrome } = theme;

  return (
    <Pressable
      accessibilityLabel="Locate me"
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.fab,
        {
          backgroundColor: chrome.island,
          borderColor: chrome.islandBorder,
          opacity: disabled ? 0.45 : pressed ? 0.68 : 1,
        },
      ]}
    >
      <SymbolView
        name={{ ios: 'location.fill', android: 'my_location', web: 'my_location' }}
        size={21}
        tintColor={disabled ? chrome.steel : chrome.amber}
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
