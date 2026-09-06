import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet } from 'react-native';

import type { CryptidTheme } from '@/constants/cryptid-theme';
import { Spacing } from '@/constants/theme';

/**
 * Side of the chevron's touch target, and the header row's floor. The chevron is what sets a
 * collapsed body's height, so when it is hidden (ME below the exploration cutoff) the header would
 * otherwise shrink to the 28pt minimized hero line and the island would read visibly thinner. One
 * constant for both keeps the two states the same height by construction — and keeps ME and
 * FRIENDS collapsing to the SAME bubble, which is the only reason the shape reads as one panel
 * being minimized rather than two panels that happen to be small.
 */
export const ISLAND_TOGGLE_SIZE = 48;

interface IslandMinimizeToggleProps {
  readonly minimized: boolean;
  /**
   * What is being collapsed, lower-case, for the screen reader: "location summary", "friends
   * roster". The visible control is a chevron and says nothing.
   */
  readonly subject: string;
  readonly theme: CryptidTheme;
  onToggle(): void;
}

/**
 * The one chevron that collapses a drawer body to its header line.
 *
 * Shared rather than duplicated because the two bodies have to agree on its size: it is the tallest
 * thing in either header, so it — not the type — is what makes the minimized ME island and the
 * minimized roster the same object at the same height.
 */
export function IslandMinimizeToggle({
  minimized,
  subject,
  theme,
  onToggle,
}: IslandMinimizeToggleProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${minimized ? 'Expand' : 'Minimize'} ${subject}`}
      accessibilityState={{ expanded: !minimized }}
      onPress={onToggle}
      style={({ pressed }) => [styles.toggle, pressed && styles.togglePressed]}
    >
      <SymbolView
        name={
          minimized
            ? { ios: 'chevron.up', android: 'keyboard_arrow_up', web: 'keyboard_arrow_up' }
            : { ios: 'chevron.down', android: 'keyboard_arrow_down', web: 'keyboard_arrow_down' }
        }
        size={20}
        tintColor={theme.chrome.steel}
      />
    </Pressable>
  );
}

/**
 * Header geometry every drawer body shares, so "minimized" is one shape rather than each body's
 * idea of small. `expanded`/`minimized` are the body's outer padding; `header` is the row the
 * chevron sits in; `summary` is the accessible block to its left.
 */
export const islandBody = StyleSheet.create({
  expanded: {
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
  },
  minimized: {
    paddingLeft: Spacing.four,
    paddingRight: Spacing.three,
    paddingVertical: Spacing.one,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    // Floor, not a fixed height: with the chevron present the row already measures
    // ISLAND_TOGGLE_SIZE, so this only takes effect when it is hidden.
    minHeight: ISLAND_TOGGLE_SIZE,
  },
  summary: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
});

const styles = StyleSheet.create({
  toggle: {
    width: ISLAND_TOGGLE_SIZE,
    height: ISLAND_TOGGLE_SIZE,
    borderRadius: ISLAND_TOGGLE_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  togglePressed: {
    opacity: 0.55,
  },
});
