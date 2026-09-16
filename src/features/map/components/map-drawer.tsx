'use no memo'; // react-compiler: the drawer's height is a Reanimated shared value

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
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
  clampDetent,
  detentHeights,
  drawerChrome,
  GRIP_HEIGHT,
  pickDetent,
  TAB_BAR_HEIGHT,
  type DrawerDetent,
} from '../core/drawer-detents';
import { GlassFill, useGlassAvailable } from './glass-surface';
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
const ISLAND_RADIUS = 24;

/**
 * Gap under the island at rest: the bottom inset itself, so the surface stops ABOVE the system's
 * bar rather than behind it.
 *
 * The drawer once floated `insetBottom + Spacing.three` up — 46pt of empty canvas, none of it map
 * and none of it island — and the correction overshot: hugging the edge at a flat 8pt and keeping
 * the handle clear from INSIDE the sheet put the home indicator in the strip between the island's
 * bottom edge and the ME/FRIENDS row, where it read as a band of dead island under the tabs. The
 * island now ends where that band began, and the bar sits on the map, which is the only surface it
 * has ever belonged on. On a device with no bottom inset there is nothing to clear and only the
 * minimum gap remains.
 *
 * The tab row still sits the same distance from the screen's edge at EVERY detent: as the sheet
 * docks it gives up the whole of that margin and the row takes exactly that much padding back. The
 * bar is the app's only navigation and it is present at every height — having it drift upward as
 * the drawer opened made the one fixed thing on screen the thing that moved.
 */
const MIN_EDGE_GAP = Spacing.two;

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
  readonly minDetent?: DrawerDetent;
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
 * scrolling three rows inside a letterbox. At the top detent it is the other way round: the body
 * is a list, and a drag is only the drawer's once the list has run out of anywhere to go. That is
 * what the grip is for.
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
  minDetent = 'peek',
  detent,
  onDetentChange,
  onSelectTab,
}: MapDrawerProps) {
  const { chrome } = theme;
  const glass = useGlassAvailable();
  const [peekBody, setPeekBody] = useState(0);
  // The tab bar as laid out, not as estimated. `peek` is body + chrome and the bar is then laid
  // out inside that total, so a chrome figure a hairline under the truth hands the body a
  // ScrollView shorter than its own content — which is what made the ME panel, a body that has
  // nothing to scroll, scroll.
  const [tabBarHeight, setTabBarHeight] = useState(TAB_BAR_HEIGHT);
  // The list's own scroll, as a gesture the drawer's pan can be declared simultaneous with.
  // Without it RNGH treats the two as competitors and the pan wins, so the roster would refuse to
  // scroll at the very detent that exists to let it.
  const nativeScroll = useMemo(() => Gesture.Native(), []);
  const height = useSharedValue(0);
  const startHeight = useSharedValue(0);
  const gestureActive = useSharedValue(false);

  const detents = useMemo(() => allowedDetents(maxDetent, minDetent), [maxDetent, minDetent]);
  const topDetent = detents[detents.length - 1];
  // A body with a single detent gets no grip: there is nothing to drag it to, and the strip would
  // be a handle on a surface that cannot move. Minimized, that is also what turns the drawer back
  // into the bare bubble the island used to collapse to.
  const hasGrip = detents.length > 1;
  // How far the whole surface floats above the screen's edge at rest. The inset is the system
  // bar's own band, so clearing it is what keeps that bar off the island entirely.
  const restMargin = Math.max(insetBottom, MIN_EDGE_GAP);
  // The tab row is flush with the drawer's bottom edge at rest — the clearance is the margin
  // underneath it now, which is outside the drawer and so costs the body nothing.
  const tabChrome = tabBarHeight;
  const bodyChrome = drawerChrome(hasGrip ? GRIP_HEIGHT : 0, tabChrome);
  const heights = useMemo(
    () =>
      detentHeights({
        peekBody,
        screenHeight,
        insetTop,
        insetBottom,
        margin: Spacing.three,
        gripHeight: hasGrip ? GRIP_HEIGHT : 0,
        tabBarHeight: tabChrome,
      }),
    [peekBody, screenHeight, insetTop, insetBottom, hasGrip, tabChrome]
  );
  /**
   * The stop the drawer is ACTUALLY at, which is not always the one the caller thinks it is at.
   *
   * `maxDetent`/`minDetent` are props and they move under a resting drawer: zooming past the
   * exploration cutoff takes `collapsed` away from the ME panel, opening the roster gives `full`
   * back. The caller's `detent` is not reset when that happens, so it can point at a stop that is
   * no longer allowed — and everything downstream then disagrees about where the drawer is. Height
   * resolved one way while the body was styled the other, and `measureBody` (which declines to
   * measure at `collapsed`) went on feeding `peek` the height of a body that had left the screen:
   * a one-line panel inside an island sized for the three-line one, with a band of empty glass
   * under it. Resolve it in ONE place and push the correction back to the caller below.
   */
  const effective = clampDetent(detent, detents);
  const resolved = heights[effective];
  /**
   * Whether the body is a list to be read rather than a summary to be glanced at, and whether that
   * list has anywhere to scroll where the drawer is now.
   *
   * Both are asked of the RESTING geometry: `peekBody` is the body's own measured height and
   * `resolved - bodyChrome` is the frame that detent gives it. Deliberately not the live layout —
   * a height that is mid-spring is briefly shorter than its destination, and asking the ScrollView
   * itself would hand a body with nothing to scroll a third of a point of slack on the way past.
   * That is the whole of the ME panel's remaining bounce: content 118, frame 117.6666, iOS bounce
   * turning a rounding error into a pull that springs back under your finger.
   */
  const bodyIsList = effective === topDetent;
  const listScrolls = peekBody > resolved - bodyChrome + 1;

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

  // Hand the correction back, so the caller's state stops describing a stop that no longer exists.
  // An effect rather than a render-time call: `onDetentChange` is the parent's setState.
  useEffect(() => {
    if (effective !== detent) onDetentChange(effective);
  }, [detent, effective, onDetentChange]);

  const commitDetent = useCallback(
    (next: DrawerDetent) => {
      if (next !== detent) onDetentChange(next);
    },
    [detent, onDetentChange]
  );

  const pans = useMemo(() => {
    const lo = heights[detents[0]];
    const hi = heights[topDetent];
    // At the top detent the body is a list rather than a summary, so the two gestures overlap and
    // have to be divided. A drag belongs to whichever thing can actually move in that direction:
    // upward is always the list's, and downward is too whenever the list still has somewhere to
    // scroll. Pulling a scrollable list down used to resize the drawer instead, which shrank the
    // ScrollView out from under the finger reading it — the list overscrolled, its content reflowed
    // at the new height, and a friend's pane swapped to its shorter summary mid-drag. The grip is
    // the drawer's handle; a body with nothing left to scroll is the only one that doubles as one.
    //
    // This used to consult the live scroll offset instead, so that a list dragged back to its top
    // handed the rest of the drag to the drawer. Two things were wrong with that: the drawer took
    // over carrying the WHOLE translation since touch-down, so it jumped by however far the list
    // had already been scrolled, and the offset arrived from the JS thread a frame or two late. It
    // is no longer consulted at all, which is why the list's offset is no longer tracked.
    const makePan = (fromGrip: boolean) =>
      Gesture.Pan()
        // A drawer with one detent, or one whose stops have collapsed onto each other, has nowhere
        // to go. It used to rubber-band anyway, and on the ME panel — sized to its body to the
        // pixel — that dip was enough to make the ScrollView shorter than its own content, so the
        // panel scrolled under the finger. This is the same judgement `hasGrip` makes about the
        // grip strip, applied to the drag itself.
        .enabled(hi > lo)
        .simultaneousWithExternalGesture(nativeScroll)
        .onStart(() => {
          gestureActive.value = true;
          startHeight.value = height.value;
        })
        .onUpdate((event) => {
          if (!fromGrip && bodyIsList && (listScrolls || event.translationY <= 0)) return;
          const next = startHeight.value - event.translationY;
          // Rubber-band past both ends rather than hard-stopping: a drawer that simply refuses to
          // move reads as a frozen app, and the resistance says "this is as far as it goes".
          height.value =
            next < lo ? lo - (lo - next) * 0.35 : next > hi ? hi + (next - hi) * 0.18 : next;
        })
        .onEnd((event) => {
          if (!fromGrip && bodyIsList && (listScrolls || event.translationY <= 0)) return;
          const next = pickDetent(
            height.value,
            event.velocityY,
            startHeight.value,
            detents,
            heights
          );
          height.value = withSpring(heights[next], SETTLE);
          runOnJS(commitDetent)(next);
        })
        .onFinalize(() => {
          gestureActive.value = false;
        });
    return { grip: makePan(true), body: makePan(false) };
    // Shared values (`height`, `startHeight`) are stable refs and are deliberately not listed: the
    // real inputs are the detents and the resolved heights.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bodyIsList, commitDetent, detents, heights, listScrolls, nativeScroll, topDetent]);

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
      marginBottom: restMargin * (1 - dock),
      borderBottomLeftRadius: ISLAND_RADIUS * (1 - dock),
      borderBottomRightRadius: ISLAND_RADIUS * (1 - dock),
      borderBottomWidth: StyleSheet.hairlineWidth * (1 - dock),
      borderLeftWidth: StyleSheet.hairlineWidth * (1 - dock),
      borderRightWidth: StyleSheet.hairlineWidth * (1 - dock),
    };
  });
  // At rest the margin under the drawer is the whole of the clearance and the row needs no padding
  // of its own; a docked sheet has no margin left, so the row takes on exactly what the margin
  // gives up. Either way the row's distance from the screen's bottom edge is the same at peek and
  // at full, and the bar does not travel.
  const tabPadStyle = useAnimatedStyle(() => {
    const dock =
      heights[topDetent] > heights[detents[0]]
        ? interpolate(height.value, [heights.full - DOCK_SPAN, heights.full], [0, 1], 'clamp')
        : 0;
    return { paddingBottom: restMargin * dock };
  });

  const measureTabs = useCallback((event: LayoutChangeEvent) => {
    const measured = Math.ceil(event.nativeEvent.layout.height);
    setTabBarHeight((current) => (current === measured ? current : measured));
  }, []);

  const measureBody = useCallback(
    (event: LayoutChangeEvent) => {
      if (effective === 'collapsed' || gestureActive.value) return;
      const measured = Math.ceil(event.nativeEvent.layout.height);
      setPeekBody((current) => (Math.abs(current - measured) > 1 ? measured : current));
    },
    [effective, gestureActive]
  );

  const onScrollBeginDrag = useCallback(() => {
    gestureActive.value = true;
  }, [gestureActive]);
  const onScrollEndDrag = useCallback(() => {
    gestureActive.value = false;
  }, [gestureActive]);

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
        {
          backgroundColor: glass ? 'transparent' : chrome.island,
          borderColor: chrome.islandBorder,
        },
        dockStyle,
      ]}
    >
      {/* A flat fill under everything, clipped to the drawer's animated shape by the
          `overflow: hidden` above. The glass deliberately does NOT own the radii: Reanimated
          drives the dock interpolation on the UI thread and cannot push per-frame values into a
          native custom prop, so letting the material carry `borderBottomLeftRadius` would mean
          crossing to JS every frame of a drag. Its own corner configuration is the island's, which
          is the shape it actually has at peek and mid; at full the bottom corners are square and
          the parent's clip is what says so. */}
      {glass ? (
        <GlassFill pointerEvents="none" radius={ISLAND_RADIUS} scheme={theme.scheme} />
      ) : null}

      <View style={styles.sheet}>
        {hasGrip ? (
          <GestureDetector gesture={pans.grip}>
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
          </GestureDetector>
        ) : null}

        <GestureDetector gesture={pans.body}>
          <View style={styles.body}>
            <GestureDetector gesture={nativeScroll}>
              <ScrollView
                // iOS bounces a ScrollView vertically even when its content fits, which made the
                // ME panel — a body that always fits its own detent — feel like a list that had
                // somewhere to go and then sprang back. Bounce only when there is genuinely more
                // body than drawer, which is the case this ScrollView actually exists for.
                alwaysBounceVertical={false}
                // A body that fits the detent it is in cannot scroll, rather than scrolling by
                // whatever the pixel grid happens to leave over. The heights are derived from the
                // body's own measurement, so at rest that slack is a rounding error — but a
                // ScrollView will still let you pull on a third of a point and bounce it back,
                // which is a panel twitching for a reason nobody can see.
                scrollEnabled={bodyIsList && listScrolls}
                onScrollBeginDrag={onScrollBeginDrag}
                onScrollEndDrag={onScrollEndDrag}
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
      </View>

      <Animated.View style={tabPadStyle}>
        <View onLayout={measureTabs}>
          <IslandTabs active={activeTab} onSelect={onSelectTab} signal={signal} theme={theme} />
        </View>
      </Animated.View>
    </Animated.View>
  );
}

const DETENT_LABEL: Record<DrawerDetent, string> = {
  collapsed: 'Minimized',
  peek: 'Summary',
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
    minHeight: 0,
  },
  bodyContent: {
    flexGrow: 1,
  },
});
