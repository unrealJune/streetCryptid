import { StyleSheet, Text, View } from 'react-native';

import type { CryptidTheme } from '@/constants/cryptid-theme';
import { Spacing } from '@/constants/theme';

interface PlaceHeaderProps {
  /**
   * Where the CAMERA is — not where you are. Null while tiles are still resolving a name, and
   * null on purpose whenever something else on screen is already naming the place.
   */
  readonly placeName: string | null;
  readonly theme: CryptidTheme;
}

/**
 * The app's header: the name of the place the map is looking at, top-left, on its own small
 * island. Attribution keeps its faint mono treatment directly beneath.
 *
 * This used to be the hero of the ME body, where it was only visible on one of two tabs and
 * scrolled away with the drawer. Where you are looking is true of the whole screen, so it belongs
 * to the screen. It floats as an island rather than sitting bare on the canvas because the map
 * underneath is a dot field — plain text over it is unreadable at exactly the moments the name
 * matters, which is the reason every other piece of chrome in this app floats too.
 *
 * It carries no coverage percentage. That number belongs to the ME body, which is where the bar
 * that explains it lives; a bare "62%" in the corner is a number with no unit.
 */
export function PlaceHeader({ placeName, theme }: PlaceHeaderProps) {
  const { chrome } = theme;

  return (
    <View pointerEvents="none" style={styles.stack}>
      {placeName ? (
        <View
          accessible
          accessibilityRole="header"
          accessibilityLabel={`Map near ${placeName}`}
          style={[
            styles.island,
            { backgroundColor: chrome.island, borderColor: chrome.islandBorder },
          ]}
        >
          <Text numberOfLines={1} style={[styles.place, { color: chrome.ink }]}>
            {placeName}
          </Text>
        </View>
      ) : null}
      <Text style={[styles.attribution, { color: chrome.steel }]} numberOfLines={1}>
        © OPENSTREETMAP
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: {
    alignItems: 'flex-start',
    flexShrink: 1,
    gap: 5,
    minWidth: 0,
  },
  island: {
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: '100%',
    paddingHorizontal: Spacing.three,
    paddingVertical: 9,
  },
  place: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 20,
    letterSpacing: 1,
    lineHeight: 23,
  },
  attribution: {
    flexShrink: 1,
    fontFamily: 'IBMPlexMono_500Medium',
    fontSize: 10,
    letterSpacing: 1.2,
    opacity: 0.55,
    paddingLeft: Spacing.one,
  },
});
