import { StyleSheet, Text, View } from 'react-native';

import type { CryptidTheme } from '@/constants/cryptid-theme';
import { Spacing } from '@/constants/theme';

import { islandBody, IslandMinimizeToggle } from './island-minimize';

const SEGMENTS = 26;

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
  /**
   * Your chosen signal color. The flip-dot bar counts ground *you* covered, so
   * it fills in your color rather than the canvas amber, which now belongs only
   * to the frontier rim.
   */
  readonly signal: string;
  /**
   * Collapsed to the header line. Owned by the screen rather than by this body:
   * minimizing is a statement about the DRAWER, which has to stop offering
   * detents at the same moment, and a body cannot make that call from in here.
   */
  readonly minimized: boolean;
  onToggleMinimize(): void;
}

/**
 * The drawer's ME body: hero place name, one mono sub line, one flip-dot
 * coverage bar, one percentage — and nothing else (declutter law). Doubles as
 * the screen-reader text model for the canvas (PRODUCT.md P0).
 *
 * The place name is the hero HERE, not in the top chrome. It was briefly promoted to a
 * floating header on the theory that "where the camera is" is true of the whole screen; in
 * practice it put a second panel over the map to say what this one already said well, and
 * the map is the thing the chrome is supposed to stay out of the way of.
 *
 * The card surface belongs to `MapDrawer`; this only supplies its own padding.
 */
export function CoverageIsland({
  theme,
  placeName,
  coverage,
  sectorsVisible,
  signal,
  minimized,
  onToggleMinimize,
}: CoverageIslandProps) {
  const { chrome } = theme;
  const pct = Math.round(coverage * 100);
  const lit = Math.round(coverage * SEGMENTS);
  const hero = placeName ?? '—';
  // Zooming past the exploration cutoff collapses the island like the chevron
  // would, WITHOUT writing `minimized` — zooming back in restores the user's
  // own choice rather than whatever the zoom left behind.
  const showSectors = sectorsVisible && !minimized;
  const summary = sectorsVisible
    ? `${hero}. ${pct} percent of visible sectors explored.`
    : `${hero}. Sector coverage is hidden at this zoom.`;

  return (
    <View style={showSectors ? islandBody.expanded : islandBody.minimized}>
      <View style={islandBody.header}>
        <View
          accessible
          accessibilityRole="summary"
          accessibilityLabel={summary}
          style={islandBody.summary}
        >
          <Text
            style={[styles.hero, !showSectors && styles.heroMinimized, { color: chrome.ink }]}
            numberOfLines={1}
          >
            {hero}
          </Text>
          {sectorsVisible && minimized ? (
            <Text style={[styles.compactPct, { color: chrome.ink }]}>{pct}%</Text>
          ) : null}
        </View>
        {sectorsVisible ? (
          <IslandMinimizeToggle
            minimized={minimized}
            onToggle={onToggleMinimize}
            subject="location summary"
            theme={theme}
          />
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
