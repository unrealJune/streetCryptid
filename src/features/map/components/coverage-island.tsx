import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { CryptidTheme } from '@/constants/cryptid-theme';
import { Spacing } from '@/constants/theme';

const SEGMENTS = 26;

/**
 * Side of the chevron's touch target, and the header's floor. The chevron is what sets the
 * island's collapsed height, so when it is hidden (below the exploration cutoff) the header would
 * otherwise shrink and the body would read visibly thinner. One constant for both keeps the two
 * states the same height by construction.
 */
const TOGGLE_SIZE = 48;

interface CoverageIslandProps {
  readonly theme: CryptidTheme;
  /** Discovered fraction of the visible sectors, 0–1. */
  readonly coverage: number;
  /**
   * Whether the exploration layer is drawn at this zoom. When false the whole sector readout is
   * suppressed — `coverage` would otherwise render a misleading 0%. The user's own minimize choice
   * is kept untouched, so zooming back in restores whatever state they left it in.
   */
  readonly sectorsVisible: boolean;
  /**
   * Your chosen signal color. The flip-dot bar counts ground *you* covered, so it fills in your
   * color rather than the canvas amber, which now belongs only to the frontier rim.
   */
  readonly signal: string;
}

/**
 * The drawer's ME body: how much of what you are looking at you have actually walked.
 *
 * It used to lead with the place name as a 34pt hero. That name is now `PlaceHeader`, at the top
 * of the screen, true on both tabs — so leading with it here would be the same words twice, which
 * is the one thing the declutter law names outright. What is left is the thing only this body can
 * say: SECTORS IN VIEW, one flip-dot bar, one percentage.
 *
 * The card surface belongs to `MapDrawer`; this only supplies its own padding.
 */
export function CoverageIsland({ theme, coverage, sectorsVisible, signal }: CoverageIslandProps) {
  const { chrome } = theme;
  const [isMinimized, setIsMinimized] = useState(false);
  const pct = Math.round(coverage * 100);
  const lit = Math.round(coverage * SEGMENTS);
  // Zooming past the exploration cutoff collapses the body like the chevron would, WITHOUT
  // writing `isMinimized` — zooming back in restores the user's own choice rather than whatever
  // the zoom left behind.
  const showSectors = sectorsVisible && !isMinimized;

  return (
    <View style={styles.body}>
      <View style={styles.header}>
        <View
          accessible
          accessibilityRole="summary"
          accessibilityLabel={
            sectorsVisible
              ? `${pct} percent of visible sectors explored.`
              : 'Sector coverage is hidden at this zoom.'
          }
          style={styles.summary}
        >
          <Text style={[styles.title, { color: chrome.ink }]} numberOfLines={1}>
            {sectorsVisible ? 'SECTORS IN VIEW' : 'ZOOM IN FOR SECTORS'}
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
          <View style={styles.barRow}>
            <View style={styles.bar}>
              {Array.from({ length: SEGMENTS }, (_, i) => (
                <View
                  key={i}
                  style={[styles.seg, { backgroundColor: i < lit ? signal : chrome.seg }]}
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
  body: {
    paddingBottom: Spacing.two,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.one,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
    // Floor, not a fixed height: with the chevron present the row already measures TOGGLE_SIZE,
    // so this only takes effect when it is hidden.
    minHeight: TOGGLE_SIZE,
  },
  summary: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: Spacing.two,
    minWidth: 0,
  },
  title: {
    flex: 1,
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 24,
    letterSpacing: 3,
    lineHeight: 28,
  },
  compactPct: {
    fontFamily: 'Rajdhani_600SemiBold',
    fontSize: 16,
    minWidth: 40,
    textAlign: 'right',
  },
  toggle: {
    alignItems: 'center',
    borderRadius: TOGGLE_SIZE / 2,
    height: TOGGLE_SIZE,
    justifyContent: 'center',
    width: TOGGLE_SIZE,
  },
  togglePressed: {
    opacity: 0.55,
  },
  barRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
    marginTop: Spacing.one,
    paddingBottom: Spacing.two,
  },
  bar: {
    flex: 1,
    flexDirection: 'row',
    gap: 3,
  },
  seg: {
    borderRadius: 1.5,
    flex: 1,
    height: 8,
  },
  pct: {
    fontFamily: 'Rajdhani_600SemiBold',
    fontSize: 18,
    minWidth: 44,
    textAlign: 'right',
  },
});
