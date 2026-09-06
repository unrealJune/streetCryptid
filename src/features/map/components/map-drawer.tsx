'use no memo'; // react-compiler: the drawer's height and scroll offset are Reanimated shared values

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ScrollView,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import type { CryptidTheme } from '@/constants/cryptid-theme';
import { Spacing } from '@/constants/theme';

import {
  allowedDetents,
  detentHeights,
  GRIP_HEIGHT,
  pickDetent,
  type DrawerDetent,
} from '../core/drawer-detents';
import { IslandTabs, type IslandTab } from './island-tabs';

export type { DrawerDetent };

/** Travel (px) over which the island docks into a full-width sheet. */
const DOCK_SPAN = 72;

/**
 * Spring for every settle. Slightly over-damped: the drawer is a surface being placed, not a thing
 * being thrown, and an overshoot on a list of friends' locations reads as sloppiness.
 */
const SETTLE = { damping: 26, stiffness: 240, mass: 0.9 } as const;

/** Corner radius at peek/mid, matching the island this drawer grew out of. */
const ISLAND_RADIUS = 26;

interface MapDrawerProps {
  readonly children: ReactNode;
  /** Which tab is lit. The bar is pinned to the drawer's bottom edge at every detent. */
  readonly activeTab: IslandTab;
  /** Your chosen signal color, worn by the ME tab. */
  readonly signal: string;
  readonly theme: CryptidTheme;
  /** Safe-area insets: the drawer clears the gesture bar at rest and the notch when full. */
  readonly insetBottom: number;
  readonly insetTop: number;
  /** Usable screen height, measured by the caller (the drawer is absolutely positioned). */
  readonly screenHeight: number;
  /**
   * Highest detent this body can reach. A friend's detail pane has a bounded amount to say, so
   * letting it climb to full would leave a screen of blank island under the last row.
   */
  readonly maxDetent?: DrawerDetent;
  readonly detent: DrawerDetent;
  onDetentChange(detent: DrawerDetent): void;
  onSelectTab(tab: IslandTab): void;
}

/**
 * The bottom drawer the whole app is read through — the island from `MapIsland`, given detents.
 *
 * It is one surface with three resting heights rather than three surfaces: at `peek` and `mid` it
 * keeps the island's side inset and full radius, and at `full` it docks edge-to-edge with only its
 * top corners rounded. That progression is the point of the component. A separate full-screen
 * sheet would have been less code and would have thrown away the thing that makes this app's
 * chrome legible — that there is exactly one panel, and it moves.
 *
 * HEIGHT is what animates, not translation. The body lays out against the drawer's real height at
 * every frame, so the tab bar stays welded to the bottom edge and the list gets taller as the
 * drawer rises. Translating a fixed-height sheet would be cheaper and would slide the tab bar off
 * the bottom of the screen at peek.
 *
 * The list only scrolls at the drawer's top detent. Below that, a drag on the body is the
 * drawer's — which is what makes "scroll up on the roster" grow it to full screen instead of
 * scrolling three rows inside a letterbox.
 */
export function MapDrawer({
  children,
  activeTab,
  signal,
  theme,
  insetBottom,
  insetTop,
  screenHeight,
  maxDetent = 'full',
  detent,
  onDetentChange,
  onSelectTab,
}: MapDrawerProps) {
  const { chrome } = theme;
  const [peekBody, setPeekBody] = useState(0);
  // The list's own scroll, as a gesture the drawer's pan can be declared simultaneous with.
  // Without it RNGH treats the two as competitors and the pan wins, so the roster would refuse to
  // scroll at the very detent that exists to let it.
  const nativeScroll = useMemo(() => Gesture.Native(), []);
  // Scroll offset on the UI thread: the pan gesture has to know, mid-gesture, whether the list
  // underneath it is already at the top.
  const scrollY = useSharedValue(0);
  const height = useSharedValue(0);
  const startHeight = useSharedValue(0);

  const detents = useMemo(() => allowedDetents(maxDetent), [maxDetent]);
  const topDetent = detents[detents.length - 1];
  // A body with a single detent gets no grip: there is nothing to drag it to, and the strip would
  // be a handle on a surface that cannot move. Minimized, that is also what turns the drawer back
  // into the bare bubble the island used to collapse to.
  const hasGrip = detents.length > 1;
  const heights = useMemo(
    () =>
      detentHeights({
        peekBody,
        screenHeight,
        insetTop,
        insetBottom,
        margin: Spacing.three,
        gripHeight: hasGrip ? GRIP_HEIGHT : 0,
      }),
    [peekBody, screenHeight, insetTop, insetBottom, hasGrip]
  );
  const resolved = heights[detents.includes(detent) ? detent : topDetent];

  // Settle whenever the resolved height changes: a detent change, a rotation, a body that grew a
  // row, or the first real measurement. An effect rather than a render-time write, because
  // touching a shared value during render is exactly the thing Reanimated warns about.
  const animated = useRef(false);
  useEffect(() => {
    if (resolved <= 0) return;
    if (!animated.current) {
      animated.current = true;
      height.value = resolved;
      return;
    }
    height.value = withSpring(resolved, SETTLE);
    // `height` is a shared value — a stable ref, and listing it would make this a hook argument
    // the body is not allowed to modify. `resolved` is the real input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved]);

  const commitDetent = useCallback(
    (next: DrawerDetent) => {
      if (next !== detent) onDetentChange(next);
    },
    [detent, onDetentChange]
  );

  const pan = useMemo(() => {
    const lo = heights[detents[0]];
    const hi = heights[topDetent];
    const scrolls = detent === topDetent;
    return Gesture.Pan()
      .simultaneousWithExternalGesture(nativeScroll)
      .onStart(() => {
        startHeight.value = height.value;
      })
      .onUpdate((event) => {
        // At the top detent the body is a scrolling list and the gestures have to be shared: only
        // a downward drag from the very top of that list belongs to the drawer. Below the top
        // detent nothing scrolls, so every drag is the drawer's.
        if (scrolls && (event.translationY <= 0 || scrollY.value > 1)) return;
        const next = startHeight.value - event.translationY;
        // Rubber-band past both ends rather than hard-stopping: a drawer that simply refuses to
        // move reads as a frozen app, and the resistance says "this is as far as it goes".
        height.value =
          next < lo ? lo - (lo - next) * 0.35 : next > hi ? hi + (next - hi) * 0.18 : next;
      })
      .onEnd((event) => {
        if (scrolls && (event.translationY <= 0 || scrollY.value > 1)) return;
        const next = pickDetent(height.value, event.velocityY, startHeight.value, detents, heights);
        height.value = withSpring(heights[next], SETTLE);
        runOnJS(commitDetent)(next);
      });
    // Shared values (`height`, `startHeight`, `scrollY`) are stable refs and are deliberately not
    // listed: the real inputs are the detents and the resolved heights.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commitDetent, detent, detents, heights, nativeScroll, topDetent]);

  const dockStyle = useAnimatedStyle(() => {
    const dock =
      heights[topDetent] > heights[detents[0]]
        ? interpolate(height.value, [heights.full - DOCK_SPAN, heights.full], [0, 1], 'clamp')
        : 0;
    return {
      height: height.value,
      // The island becomes a sheet across the last stretch of travel: side inset, bottom radius
      // and side borders fall away together, so it reads as one surface docking.
      marginHorizontal: Spacing.three * (1 - dock),
      marginBottom: (insetBottom + Spacing.three) * (1 - dock),
      borderBottomLeftRadius: ISLAND_RADIUS * (1 - dock),
      borderBottomRightRadius: ISLAND_RADIUS * (1 - dock),
      borderBottomWidth: StyleSheet.hairlineWidth * (1 - dock),
      borderLeftWidth: StyleSheet.hairlineWidth * (1 - dock),
      borderRightWidth: StyleSheet.hairlineWidth * (1 - dock),
    };
  });
  // The tab bar clears the home indicator only once the drawer has docked; before that the
  // drawer's own bottom margin is already doing it.
  const tabPadStyle = useAnimatedStyle(() => {
    const dock =
      heights[topDetent] > heights[detents[0]]
        ? interpolate(height.value, [heights.full - DOCK_SPAN, heights.full], [0, 1], 'clamp')
        : 0;
    return { paddingBottom: insetBottom * dock };
  });

  const measureBody = useCallback((event: LayoutChangeEvent) => {
    const measured = Math.ceil(event.nativeEvent.layout.height);
    setPeekBody((current) => (Math.abs(current - measured) > 1 ? measured : current));
  }, []);

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      scrollY.value = event.nativeEvent.contentOffset.y;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // Dragging is not the only way to work a drawer: assistive tech gets the same three stops.
  const step = useCallback(
    (delta: number) => {
      const index = detents.indexOf(detent);
      const next = detents[Math.min(detents.length - 1, Math.max(0, index + delta))];
      if (next !== detent) onDetentChange(next);
    },
    [detent, detents, onDetentChange]
  );

  return (
    <Animated.View
      style={[
        styles.drawer,
        { backgroundColor: chrome.island, borderColor: chrome.islandBorder },
        dockStyle,
      ]}
    >
      <GestureDetector gesture={pan}>
        <View style={styles.sheet}>
          {hasGrip ? (
            <View
              accessibilityRole="adjustable"
              accessibilityLabel="Panel size"
              accessibilityValue={{ text: DETENT_LABEL[detent] }}
              accessibilityActions={ADJUST_ACTIONS}
              onAccessibilityAction={(event) =>
                step(event.nativeEvent.actionName === 'increment' ? 1 : -1)
              }
              style={styles.grip}
            >
              <View style={[styles.gripBar, { backgroundColor: chrome.seg }]} />
            </View>
          ) : null}

          <GestureDetector gesture={nativeScroll}>
            <ScrollView
              scrollEnabled={detent === topDetent}
              onScroll={onScroll}
              scrollEventThrottle={16}
              showsVerticalScrollIndicator={false}
              style={styles.body}
              contentContainerStyle={styles.bodyContent}
            >
              {/* Measured at its natural height — that measurement is what `peek` derives from. */}
              <View onLayout={measureBody}>{children}</View>
            </ScrollView>
          </GestureDetector>
        </View>
      </GestureDetector>

      <Animated.View style={tabPadStyle}>
        <IslandTabs active={activeTab} onSelect={onSelectTab} signal={signal} theme={theme} />
      </Animated.View>
    </Animated.View>
  );
}

const DETENT_LABEL: Record<DrawerDetent, string> = {
  peek: 'Collapsed',
  mid: 'Half open',
  full: 'Full screen',
};

const ADJUST_ACTIONS = [{ name: 'increment' as const }, { name: 'decrement' as const }];

const styles = StyleSheet.create({
  drawer: {
    borderTopLeftRadius: ISLAND_RADIUS,
    borderTopRightRadius: ISLAND_RADIUS,
    borderTopWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  sheet: {
    flex: 1,
    minHeight: 0,
  },
  grip: {
    alignItems: 'center',
    height: GRIP_HEIGHT,
    justifyContent: 'center',
  },
  gripBar: {
    borderRadius: 2,
    height: 4,
    width: 36,
  },
  body: {
    flex: 1,
  },
  bodyContent: {
    flexGrow: 1,
  },
});
