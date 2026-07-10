import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { CryptidTheme } from '@/constants/cryptid-theme';
import { Spacing } from '@/constants/theme';

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
  const [isMinimized, setIsMinimized] = useState(false);
  const pct = Math.round(coverage * 100);
  const lit = Math.round(coverage * SEGMENTS);
  const hero = placeName ?? '—';
  const summary = `${hero}. ${pct} percent of visible sectors explored.`;

  return (
    <View
      style={[
        styles.island,
        isMinimized ? styles.islandMinimized : styles.islandExpanded,
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
            style={[styles.hero, isMinimized && styles.heroMinimized, { color: chrome.ink }]}
            numberOfLines={1}
          >
            {hero}
          </Text>
          {isMinimized ? (
            <Text style={[styles.compactPct, { color: chrome.ink }]}>{pct}%</Text>
          ) : null}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={isMinimized ? 'Expand location summary' : 'Minimize location summary'}
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
      </View>

      {!isMinimized ? (
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Text style={[styles.sub, { color: chrome.steel }]} numberOfLines={1}>
            SECTORS IN VIEW · © OPENSTREETMAP
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
    width: 48,
    height: 48,
    borderRadius: 24,
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
