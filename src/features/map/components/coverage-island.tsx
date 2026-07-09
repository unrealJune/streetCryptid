import { StyleSheet, Text, View } from 'react-native';

import type { CryptidTheme } from '@/constants/cryptid-theme';

const SEGMENTS = 26;

interface CoverageIslandProps {
  readonly theme: CryptidTheme;
  /** Hero place name; em-dash placeholder while tiles are still loading. */
  readonly placeName: string | null;
  /** Discovered fraction of the visible sectors, 0–1. */
  readonly coverage: number;
}

/**
 * The bottom "where you are" island: hero place name, one mono sub line, one
 * flip-dot coverage bar, one percentage — and nothing else (declutter law).
 * Doubles as the screen-reader text model for the canvas (PRODUCT.md P0).
 */
export function CoverageIsland({ theme, placeName, coverage }: CoverageIslandProps) {
  const { chrome } = theme;
  const pct = Math.round(coverage * 100);
  const lit = Math.round(coverage * SEGMENTS);
  const hero = placeName ?? '—';

  return (
    <View
      accessibilityRole="summary"
      accessibilityLabel={`${hero}. ${pct} percent of visible sectors explored.`}
      style={[styles.island, { backgroundColor: chrome.island, borderColor: chrome.islandBorder }]}
    >
      <Text style={[styles.hero, { color: chrome.ink }]} numberOfLines={1}>
        {hero}
      </Text>
      <Text style={[styles.sub, { color: chrome.steel }]} numberOfLines={1}>
        SECTORS IN VIEW · © OPENSTREETMAP
      </Text>
      <View style={styles.barRow}>
        <View style={styles.bar} accessibilityElementsHidden>
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
  );
}

const styles = StyleSheet.create({
  island: {
    borderRadius: 26,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 22,
    paddingTop: 18,
    paddingBottom: 20,
  },
  hero: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 34,
    lineHeight: 38,
  },
  sub: {
    fontFamily: 'IBMPlexMono_500Medium',
    fontSize: 10,
    letterSpacing: 1.2,
    marginTop: 2,
  },
  barRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 14,
    gap: 12,
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
