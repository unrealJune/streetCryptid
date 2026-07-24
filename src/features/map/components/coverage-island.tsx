import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { CryptidTheme } from '@/constants/cryptid-theme';
import { Spacing } from '@/constants/theme';

const SEGMENTS = 26;

/**
 * Side of the chevron's touch target, and the header's floor. The chevron is
 * what sets the island's collapsed height, so when it is hidden (below the
 * exploration cutoff) the header would otherwise shrink to the 28pt minimized
 * hero line and the island would read visibly thinner. One constant for both
 * keeps the two states the same height by construction.
 */
const TOGGLE_SIZE = 48;

interface CoverageIslandProps {
  readonly theme: CryptidTheme;
  /** Hero place name; em-dash placeholder while tiles are still loading. */
  readonly placeName: string | null;
  /** Discovered fraction of the visible sectors, 0–1. */
  readonly coverage: number;
  /**
   * Whether the exploration layer is drawn at this zoom. When false the whole
   * sector readout is suppressed — `coverage` would otherwise render a
   * misleading 0%. The user's own minimize choice is kept untouched, so zooming
   * back in restores whatever state they left it in.
   */
  readonly sectorsVisible: boolean;
}

/**
 * The bottom "where you are" island: hero place name, one mono sub line, one
 * flip-dot coverage bar, one percentage — and nothing else (declutter law).
 * Doubles as the screen-reader text model for the canvas (PRODUCT.md P0).
 */
export function CoverageIsland({
  theme,
  placeName,
  coverage,
  sectorsVisible,
}: CoverageIslandProps) {
  const { chrome } = theme;
  const [isMinimized, setIsMinimized] = useState(false);
  const pct = Math.round(coverage * 100);
  const lit = Math.round(coverage * SEGMENTS);
  const hero = placeName ?? '—';
  // Zooming past the exploration cutoff collapses the island like the chevron
  // would, WITHOUT writing `isMinimized` — zooming back in restores the user's
  // own choice rather than whatever the zoom left behind.
  const showSectors = sectorsVisible && !isMinimized;
  const summary = sectorsVisible
    ? `${hero}. ${pct} percent of visible sectors explored.`
    : `${hero}. Sector coverage is hidden at this zoom.`;

  return (
    <View
      style={[
        styles.island,
        showSectors ? styles.islandExpanded : styles.islandMinimized,
        { backgroundColor: chrome.island, borderColor: chrome.islandBorder },
      ]}
    >
      <View style={styles.header}>
        <View
          accessible
          accessibilityRole="summary"
          accessibilityLabel={summary}
          style={styles.summary}
        >
          <Text
            style={[styles.hero, !showSectors && styles.heroMinimized, { color: chrome.ink }]}
            numberOfLines={1}
          >
            {hero}
          </Text>
          {sectorsVisible && isMinimized ? (
            <Text style={[styles.compactPct, { color: chrome.ink }]}>{pct}%</Text>
          ) : null}
        </View>
        {sectorsVisible ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              isMinimized ? 'Expand location summary' : 'Minimize location summary'
            }
            accessibilityState={{ expanded: !isMinimized }}
            onPress={() => setIsMinimized((current) => !current)}
            style={({ pressed }) => [styles.toggle, pressed && styles.togglePressed]}
          >
            <SymbolView
              name={
                isMinimized
                  ? { ios: 'chevron.up', android: 'keyboard_arrow_up', web: 'keyboard_arrow_up' }
                  : {
                      ios: 'chevron.down',
                      android: 'keyboard_arrow_down',
                      web: 'keyboard_arrow_down',
                    }
              }
              size={20}
              tintColor={chrome.steel}
            />
          </Pressable>
        ) : null}
      </View>

      {showSectors ? (
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Text style={[styles.sub, { color: chrome.steel }]} numberOfLines={1}>
            SECTORS IN VIEW
          </Text>
          <View style={styles.barRow}>
            <View style={styles.bar}>
              {Array.from({ length: SEGMENTS }, (_, i) => (
                <View
                  key={i}
                  style={[styles.seg, { backgroundColor: i < lit ? chrome.amber : chrome.seg }]}
                />
              ))}
            </View>
            <Text style={[styles.pct, { color: chrome.ink }]}>{pct}%</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  island: {
    borderRadius: 26,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.four,
  },
  islandExpanded: {
    paddingVertical: Spacing.two,
  },
  islandMinimized: {
    paddingLeft: Spacing.three,
    paddingRight: Spacing.two,
    paddingVertical: Spacing.one,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    // Floor, not a fixed height: with the chevron present the row already
    // measures TOGGLE_SIZE, so this only takes effect when it is hidden.
    minHeight: TOGGLE_SIZE,
  },
  summary: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  hero: {
    flex: 1,
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 34,
    lineHeight: 38,
  },
  heroMinimized: {
    fontSize: 24,
    lineHeight: 28,
  },
  compactPct: {
    fontFamily: 'Rajdhani_600SemiBold',
    fontSize: 16,
    minWidth: 40,
    textAlign: 'right',
  },
  toggle: {
    width: TOGGLE_SIZE,
    height: TOGGLE_SIZE,
    borderRadius: TOGGLE_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  togglePressed: {
    opacity: 0.55,
  },
  sub: {
    fontFamily: 'IBMPlexMono_500Medium',
    fontSize: 10,
    letterSpacing: 1.2,
    marginTop: Spacing.half,
  },
  barRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: Spacing.three,
    gap: Spacing.two,
  },
  bar: {
    flex: 1,
    flexDirection: 'row',
    gap: 3,
  },
  seg: {
    flex: 1,
    height: 8,
    borderRadius: 1.5,
  },
  pct: {
    fontFamily: 'Rajdhani_600SemiBold',
    fontSize: 18,
    minWidth: 44,
    textAlign: 'right',
  },
});
