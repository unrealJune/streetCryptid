import { useEffect, useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import Animated, {
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import type { CryptidTheme } from '@/constants/cryptid-theme';
import { Spacing } from '@/constants/theme';

import { COLLAPSED_ROW_HEIGHT } from '../core/drawer-detents';
import { useDrawerProgress } from './drawer-progress';
import { islandBody } from './island-body';

const SEGMENTS = 26;
const HERO_SIZE = 28;
const HERO_SIZE_COLLAPSED = 22;
/** Width the percentage occupies, in both its homes — the bar row and the collapsed line. */
const PCT_WIDTH = 40;

interface CoverageIslandProps {
  readonly theme: CryptidTheme;
  /** Hero place name; em-dash placeholder while tiles are still loading. */
  readonly placeName: string | null;
  /** Discovered fraction of the visible sectors, 0–1. */
  readonly coverage: number;
  /**
   * Whether a coverage percentage is measurable at this zoom (the display-resolution band). When
   * false `coverage` is a placeholder 0, so the percentage is hidden rather than claim nothing has
   * been explored — and the screen pins the drawer collapsed, so the readout is never on show
   * without a number to put in it.
   */
  readonly sectorsVisible: boolean;
  /**
   * Your chosen signal color. The flip-dot bar counts ground *you* covered, so
   * it fills in your color rather than the canvas amber, which now belongs only
   * to the frontier rim.
   */
  readonly signal: string;
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
 * ONE layout, morphed by the drawer's live height (`useDrawerProgress`) rather than swapped on
 * the detent. The body always lays out expanded — that natural height is what `peek` measures —
 * and as the island shrinks over it the readout slides out through the bottom edge, the hero eases
 * down to the collapsed line's size, and the percentage travels up out of the bar row to sit at
 * the end of that line. Swapping two layouts on release made all three jump in one frame at the
 * end of a drag that had, until then, just been clipping the expanded one.
 *
 * The card surface belongs to `MapDrawer`; this only supplies its own padding.
 */
export function CoverageIsland({
  theme,
  placeName,
  coverage,
  sectorsVisible,
  signal,
}: CoverageIslandProps) {
  const { chrome } = theme;
  // Past the cutoff `coverage` drops to a placeholder 0 at the same moment the drawer starts
  // springing shut — hold the last real number so the closing readout does not flash 0%.
  const [held, setHeld] = useState(coverage);
  if (sectorsVisible && held !== coverage) setHeld(coverage);
  const shown = sectorsVisible ? coverage : held;
  const pct = Math.round(shown * 100);
  const lit = Math.round(shown * SEGMENTS);
  const hero = placeName ?? '—';
  const summary = sectorsVisible
    ? `${hero}. ${pct} percent of visible sectors explored.`
    : `${hero}. Sector coverage is hidden at this zoom.`;

  const progress = useDrawerProgress();
  // Where the two rows sit in the expanded layout, measured rather than derived from font
  // metrics, which differ by platform. Shared values so a re-measure never re-renders.
  const headerCenter = useSharedValue(0);
  const readoutTop = useSharedValue(0);
  const barCenter = useSharedValue(0);
  // The percentage FADES when coverage stops being measurable rather than unmounting. Crossing the
  // cutoff from `peek` springs the drawer shut at the same moment, and a number that vanished on
  // that first frame left the readout closing around a hole; this way it fades as it rides up.
  // Same duration as the drawer's grip fade, so both read as one change.
  const measurable = useSharedValue(sectorsVisible ? 1 : 0);
  useEffect(() => {
    measurable.value = withTiming(sectorsVisible ? 1 : 0, { duration: 180 });
    // `measurable` is a shared value — a stable ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectorsVisible]);

  // The collapsed line's center: the row `islandBody.minimized` lays out, top-aligned under the
  // grip strip. Everything that stays visible when collapsed converges on it.
  const lineCenter = COLLAPSED_ROW_HEIGHT / 2;

  const heroStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: (1 - progress.value) * (lineCenter - headerCenter.value) },
      { scale: interpolate(progress.value, [0, 1], [HERO_SIZE_COLLAPSED / HERO_SIZE, 1]) },
    ],
  }));
  // Also gated on `measurable`: the wide column has no drawer to fold it away (progress reads a
  // constant 1 there), and a bar with no number beside it would claim a coverage nobody measured.
  const readoutStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0.35, 1], [0, 1], 'clamp') * measurable.value,
  }));
  const pctStyle = useAnimatedStyle(() => ({
    opacity: measurable.value,
    transform: [
      {
        translateY: progress.value * (readoutTop.value + barCenter.value - lineCenter),
      },
    ],
  }));

  const onHeaderLayout = (event: LayoutChangeEvent) => {
    const { y, height } = event.nativeEvent.layout;
    headerCenter.value = y + height / 2;
  };
  const onReadoutLayout = (event: LayoutChangeEvent) => {
    readoutTop.value = event.nativeEvent.layout.y;
  };
  const onBarLayout = (event: LayoutChangeEvent) => {
    const { y, height } = event.nativeEvent.layout;
    barCenter.value = y + height / 2;
  };

  return (
    <View style={islandBody.expanded} testID="coverage-island-body">
      <View style={[islandBody.header, styles.header]} onLayout={onHeaderLayout}>
        <View
          accessible
          accessibilityRole="summary"
          accessibilityLabel={summary}
          style={islandBody.summary}
        >
          <Animated.Text style={[styles.hero, { color: chrome.ink }, heroStyle]} numberOfLines={1}>
            {hero}
          </Animated.Text>
        </View>
      </View>

      <Animated.View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        onLayout={onReadoutLayout}
        style={readoutStyle}
      >
        <Text style={[styles.sub, { color: chrome.steel }]} numberOfLines={1}>
          PERCENT EXPLORED
        </Text>
        <View style={styles.barRow} onLayout={onBarLayout}>
          <View style={styles.bar}>
            {Array.from({ length: SEGMENTS }, (_, i) => (
              <View
                key={i}
                style={[styles.seg, { backgroundColor: i < lit ? signal : chrome.seg }]}
              />
            ))}
          </View>
          {/* The percentage's slot in the row, holding an invisible copy so the row keeps the
              number's height. The visible one floats, so it can leave. */}
          <Text style={[styles.pct, styles.pctSlot]}>{pct}%</Text>
        </View>
      </Animated.View>

      {/* One percentage with two homes: at the end of the collapsed line, and in the bar row's
          slot. It rests at the line and is carried down to the slot as the drawer opens. */}
      <Animated.View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        style={[styles.pctFloat, pctStyle]}
        testID="coverage-island-pct"
      >
        <Text style={[styles.pct, { color: chrome.ink }]}>{pct}%</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    // Room for the percentage when it rides up onto this line, kept at every height so the place
    // name truncates at one width rather than re-flowing mid-drag.
    paddingRight: PCT_WIDTH + Spacing.two,
  },
  hero: {
    flex: 1,
    fontFamily: 'Rajdhani_700Bold',
    fontSize: HERO_SIZE,
    lineHeight: 32,
    // Shrinks toward its leading edge, so the name stays anchored where it starts.
    transformOrigin: 'left center',
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
    marginBottom: Spacing.one,
    marginTop: Spacing.two,
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
  pctSlot: {
    opacity: 0,
  },
  pctFloat: {
    position: 'absolute',
    right: Spacing.three,
    top: 0,
    height: COLLAPSED_ROW_HEIGHT,
    justifyContent: 'center',
  },
  pct: {
    fontFamily: 'Rajdhani_600SemiBold',
    fontSize: 16,
    minWidth: PCT_WIDTH,
    textAlign: 'right',
  },
});
