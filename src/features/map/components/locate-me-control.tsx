import { SymbolView } from 'expo-symbols';
import { ActivityIndicator } from 'react-native';

import type { CryptidTheme } from '@/constants/cryptid-theme';

import { FAB_RADIUS, IslandPressable, islandStyles } from './glass-surface';

interface LocateMeControlProps {
  /** A position read is in flight. The control stays pressable-looking but does not re-fire. */
  readonly busy: boolean;
  readonly theme: CryptidTheme;
  onPress(): void;
}

/**
 * Recentre the map on the user.
 *
 * Deliberately has no disabled state for "we don't have a position yet". It used to be greyed out
 * until the app had PUBLISHED a fix, which meant a freshly installed, correctly paired app could
 * not centre its own map — the app knew where the user was, or could have asked in a few hundred
 * milliseconds, and instead presented a dead button. Pressing it is the request; if we have nothing
 * cached, the press is what goes and gets it.
 */
export function LocateMeControl({ busy, theme, onPress }: LocateMeControlProps) {
  const { chrome } = theme;

  return (
    <IslandPressable
      accessibilityLabel="Locate me"
      accessibilityRole="button"
      accessibilityState={{ busy }}
      disabled={busy}
      onPress={onPress}
      radius={FAB_RADIUS}
      style={islandStyles.fab}
      theme={theme}
    >
      {busy ? (
        <ActivityIndicator color={chrome.amber} size="small" />
      ) : (
        <SymbolView
          name={{ ios: 'location.fill', android: 'my_location', web: 'my_location' }}
          size={21}
          tintColor={chrome.amber}
        />
      )}
    </IslandPressable>
  );
}
