import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import type { CryptidTheme } from '@/constants/cryptid-theme';
import { Spacing } from '@/constants/theme';

import { GlassFill, useGlassAvailable } from './glass-surface';

const CARD_RADIUS = 24;

interface IslandColumnProps {
  readonly theme: CryptidTheme;
  /** The ME body: always shown, at its own height. */
  readonly me: ReactNode;
  /** The roster, or the friend whose pane is open. Grows with its content, then scrolls. */
  readonly children: ReactNode;
}

/**
 * The island on a wide window (tablet, unfolded foldable): ME and FRIENDS as two floating cards,
 * both open, each only as tall as what it holds.
 *
 * The phone's drawer exists because a phone has room for one of the two at a time. Stretching it
 * into a full-height column kept the tabs and gave ME — a place name, one line and a bar — the
 * whole height of the screen to sit at the top of. A wide window has room for both, so neither is
 * hidden behind a tab and there is nothing to drag: the roster card grows to fit the list, and
 * scrolls only once it reaches the bottom of the window.
 *
 * Placed by the caller (see `islandLayout`), which also tells the map how much of it the column
 * covers so whatever the map centres on is centred beside it.
 */
export function IslandColumn({ theme, me, children }: IslandColumnProps) {
  return (
    <View pointerEvents="box-none" style={styles.column}>
      <IslandCard theme={theme}>{me}</IslandCard>
      <IslandCard grows theme={theme}>
        <ScrollView
          alwaysBounceVertical={false}
          showsVerticalScrollIndicator={false}
          style={styles.scroll}
        >
          {children}
        </ScrollView>
      </IslandCard>
    </View>
  );
}

function IslandCard({
  theme,
  grows = false,
  children,
}: {
  readonly theme: CryptidTheme;
  /** May shrink below its content to fit the window (and its content then scrolls). */
  readonly grows?: boolean;
  readonly children: ReactNode;
}) {
  const glass = useGlassAvailable();
  const { chrome } = theme;
  return (
    <View
      style={[
        styles.card,
        grows && styles.cardShrinks,
        {
          backgroundColor: glass ? 'transparent' : chrome.island,
          borderColor: chrome.islandBorder,
        },
      ]}
    >
      {glass ? <GlassFill pointerEvents="none" radius={CARD_RADIUS} scheme={theme.scheme} /> : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  column: {
    flex: 1,
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
  card: {
    borderRadius: CARD_RADIUS,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    paddingVertical: Spacing.two,
  },
  cardShrinks: {
    flexShrink: 1,
    minHeight: 0,
  },
  scroll: {
    // Content height, not the space available: the card hugs a short roster, and only a list
    // longer than the window is clipped to it and scrolls.
    flexGrow: 0,
  },
});
