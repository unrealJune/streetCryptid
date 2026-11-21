'use no memo'; // react-compiler: the drawer's height is a Reanimated shared value

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  interpolate,
  runOnJS,
  scrollTo,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
  withTiming,
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
import { DrawerProgressContext } from './drawer-progress';
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

/** Scroll (px) over which a floating header's backdrop fades in once the list runs under it. */
const HEADER_BACKDROP_SPAN = 12;

interface MapDrawerProps {
  readonly children: ReactNode;
  /**
   * A title row that floats over the body instead of scrolling away with it — the roster's count
   * and its add button. It is a quick-return header: scrolling the list down slides it up out of
   * the way, and any scroll back up brings it back over whatever row is there. Tapping it (or the
   * grip) is how a list that scrolls asks for more room; see the component docs.
   */
  readonly header?: ReactNode;
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
 * Scrolling against sizing follows Find My's sheet (`UISheetPresentationController` with
 * `prefersScrollingExpandsWhenScrolledToEdge = false`), because every other division of the same
 * drag felt wrong in the hand:
 *
 *  - A body with more content than the frame it has is a LIST, at every detent. A drag on it
 *    scrolls it. It does not grow the drawer: that was the old rule (the list scrolled only at the
 *    top detent), and it meant a roster resting at `mid` with eleven friends in it simply did not
 *    scroll, and "read the next row" turned into "the panel jumps to full screen".
 *  - Pulling DOWN past the top of that list shrinks the drawer from wherever it is, the moment the
 *    list runs out — carried frame by frame, so the handoff has no jump — and the list is pinned at
 *    its top while it does. Reversing the drag gives the drawer back up to where it started, never
 *    past it.
 *  - Growing is the header's and the grip's job: tap either for the next stop up, or drag them.
 *  - A body that fits its frame (the ME panel, a short roster) has nothing to scroll, so the whole
 *    body stays a handle, in both directions, as it always was.
 *
 * Why not the system sheet itself: react-native-screens does expose it (`formSheet` with
 * `sheetAllowedDetents` / `sheetExpandsWhenScrolledToEdge`), but it is a modal presentation that
 * would own the ME/FRIENDS bar, has no collapsed island or dock morph, and would put pairing and
 * settings in a fight over who presents over whom. So the semantics are mirrored here instead.
 */
export function MapDrawer({
  children,
  header,
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
  // The body's natural height, measured on EVERY layout. `peekBody` declines to measure mid-gesture
  // (so a detent's size does not chase a body morphing under the finger), which is right for sizing
  // and was wrong for deciding whether the list scrolls: a measurement skipped while a drag was
  // settling left a full roster believing it fit, and it would not scroll at all.
  const [contentHeight, setContentHeight] = useState(0);
  const [measuredHeader, setMeasuredHeader] = useState(0);
  const headerHeight = header ? measuredHeader : 0;
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
  // The finger's travel as the drawer saw it last frame, and the drawer's un-rubber-banded height:
  // a list drag resizes by per-frame deltas, so it can start resizing partway through a drag
  // without jumping by however far the list had scrolled first.
  const lastTranslation = useSharedValue(0);
  const rawHeight = useSharedValue(0);
  const resizing = useSharedValue(false);
  // The list's offset, on the UI thread where the pan reads it. (It once arrived from JS a frame
  // or two late, which is what made the old offset handoff jump.)
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const scrollY = useSharedValue(0);
  const headerSpan = useSharedValue(0);
  const headerHidden = useSharedValue(0);

  const detents = useMemo(() => allowedDetents(maxDetent, minDetent), [maxDetent, minDetent]);
  const topDetent = detents[detents.length - 1];
  // A body with a single detent gets no grip: there is nothing to drag it to, and the strip would
  // be a handle on a surface that cannot move.
  const hasGrip = detents.length > 1;
  // ...but a drawer that can REST at `collapsed` keeps the strip's height even when it has no grip
  // in it. The collapsed body is laid out against the strip above it (`islandBody.minimized`), and
  // the ME panel loses its other stops while it sits there — zooming out past the band where
  // coverage is measurable pins it collapsed. Dropping the strip with the grip shrank the bubble by
  // 16pt at that moment; keeping it means the only thing that changes is the bar fading out.
  const gripSpace = hasGrip || detents[0] === 'collapsed' ? GRIP_HEIGHT : 0;
  // How far the whole surface floats above the screen's edge at rest. The inset is the system
  // bar's own band, so clearing it is what keeps that bar off the island entirely.
  const restMargin = Math.max(insetBottom, MIN_EDGE_GAP);
  // The tab row is flush with the drawer's bottom edge at rest — the clearance is the margin
  // underneath it now, which is outside the drawer and so costs the body nothing.
  const tabChrome = tabBarHeight;
  const bodyChrome = drawerChrome(gripSpace, tabChrome);
  const heights = useMemo(
    () =>
      detentHeights({
        peekBody: peekBody + headerHeight,
        screenHeight,
        insetTop,
        insetBottom,
        margin: Spacing.three,
        gripHeight: gripSpace,
        tabBarHeight: tabChrome,
      }),
    [peekBody, headerHeight, screenHeight, insetTop, insetBottom, gripSpace, tabChrome]
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
   * Whether the body is a list with somewhere to scroll where the drawer is now — at ANY detent.
   *
   * Asked of the RESTING geometry: the body's own measured height against `resolved - bodyChrome`,
   * the frame that detent gives it. Deliberately not the live layout —
   * a height that is mid-spring is briefly shorter than its destination, and asking the ScrollView
   * itself would hand a body with nothing to scroll a third of a point of slack on the way past.
   * That is the whole of the ME panel's remaining bounce: content 118, frame 117.6666, iOS bounce
   * turning a rounding error into a pull that springs back under your finger.
   */
  // `collapsed` is a one-line summary even when it is the only stop: a body pinned there is far
  // taller than the row it shows, and treating it as a list would let that clipped readout scroll.
  const listScrolls =
    effective !== 'collapsed' && headerHeight + contentHeight > resolved - bodyChrome + 1;

  /**
   * Where the drawer stands between `collapsed` and `peek`, frame by frame, for the body to morph
   * along with (see `drawer-progress.ts`). Bodies with no `collapsed` stop rest above it and read 1.
   */
  const progress = useDerivedValue(() => {
    const lo = heights.collapsed;
    const hi = heights.peek;
    return hi > lo ? interpolate(height.value, [lo, hi], [0, 1], 'clamp') : 1;
  }, [heights]);
  // The grip bar fades rather than popping, so the moment the drawer loses its other stops reads
  // as the handle going away and not as the island redrawing.
  const gripOpacity = useSharedValue(hasGrip ? 1 : 0);
  useEffect(() => {
    gripOpacity.value = withTiming(hasGrip ? 1 : 0, { duration: 180 });
    // `gripOpacity` is a shared value — a stable ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasGrip]);
  const gripBarStyle = useAnimatedStyle(() => ({ opacity: gripOpacity.value }));

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
    // Rubber-band past both ends rather than hard-stopping: a drawer that simply refuses to move
    // reads as a frozen app, and the resistance says "this is as far as it goes".
    const band = (next: number) => {
      'worklet';
      return next < lo ? lo - (lo - next) * 0.35 : next > hi ? hi + (next - hi) * 0.18 : next;
    };
    // `ceiling` is the highest the drawer may settle: a list drag can only ever give back room, so
    // a flick up at the end of one must not carry the drawer past the stop it started from.
    const settle = (velocityY: number, ceiling: number) => {
      'worklet';
      let next = pickDetent(height.value, velocityY, startHeight.value, detents, heights);
      if (heights[next] > ceiling + 1) {
        let index = detents.length - 1;
        while (index > 0 && heights[detents[index]] > ceiling + 1) index -= 1;
        next = detents[index];
      }
      height.value = withSpring(heights[next], SETTLE);
      runOnJS(commitDetent)(next);
    };
    // The grip, the header, and a body with nothing to scroll: a plain handle, both directions.
    const makeHandle = () =>
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
          height.value = band(startHeight.value - event.translationY);
        })
        .onEnd((event) => {
          settle(event.velocityY, Number.POSITIVE_INFINITY);
        })
        .onFinalize(() => {
          gestureActive.value = false;
        });
    // A body that scrolls. The list owns the drag, and the drawer takes only what the list cannot
    // use: a pull DOWN once the list is at its top, and the way back up to where the drag started.
    // Carried as per-frame deltas against the UI-thread offset, so the list scrolling to its top
    // and the drawer starting to shrink are one continuous motion under the finger. The list is
    // pinned at its top while the drawer moves: it does not bounce (see the ScrollView), and on the
    // way back up it would otherwise scroll by the same travel the drawer is taking.
    const makeList = () =>
      Gesture.Pan()
        .enabled(hi > lo)
        .simultaneousWithExternalGesture(nativeScroll)
        .onStart(() => {
          gestureActive.value = true;
          startHeight.value = height.value;
          rawHeight.value = height.value;
          lastTranslation.value = 0;
          resizing.value = false;
        })
        .onUpdate((event) => {
          const dy = event.translationY - lastTranslation.value;
          lastTranslation.value = event.translationY;
          if (dy === 0) return;
          const below = rawHeight.value < startHeight.value - 0.5;
          if (!below && (dy < 0 || scrollY.value > 0.5)) return;
          resizing.value = true;
          rawHeight.value = Math.min(startHeight.value, rawHeight.value - dy);
          height.value = band(rawHeight.value);
          scrollTo(scrollRef, 0, 0, false);
        })
        .onEnd((event) => {
          if (resizing.value) settle(event.velocityY, startHeight.value);
        })
        .onFinalize(() => {
          gestureActive.value = false;
        });
    return {
      grip: makeHandle(),
      header: makeHandle(),
      // The animated ref is only handed to `scrollTo` inside a UI-thread gesture callback; nothing
      // reads it during render, which is what this rule guards against.
      // eslint-disable-next-line react-hooks/refs
      body: listScrolls ? makeList() : makeHandle(),
    };
    // Shared values and the animated ref are stable and are deliberately not listed: the real
    // inputs are the detents, the resolved heights and whether the body scrolls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commitDetent, detents, heights, listScrolls, nativeScroll, topDetent]);

  /**
   * The quick-return header. It slides up by exactly as much as the list scrolls down, up to its
   * own height, and back by as much as the list scrolls up — so it returns over whatever row is
   * there the moment you head back, without waiting for the top. At rest it settles all the way
   * in or out rather than hanging half-cut. Its backdrop fades in only once rows run under it, so
   * over an unscrolled list it is the same bare title it always was.
   */
  const scrollHandler = useAnimatedScrollHandler({
    onScroll: (event) => {
      const y = event.contentOffset.y;
      const dy = y - scrollY.value;
      scrollY.value = y;
      headerHidden.value =
        y <= 0 ? 0 : Math.min(headerSpan.value, Math.max(0, headerHidden.value + dy));
    },
    onBeginDrag: () => {
      gestureActive.value = true;
    },
    onEndDrag: () => {
      gestureActive.value = false;
      const span = headerSpan.value;
      const hidden = headerHidden.value;
      if (hidden > 0 && hidden < span) {
        headerHidden.value = withTiming(scrollY.value > span && hidden > span / 2 ? span : 0, {
          duration: 160,
        });
      }
    },
    onMomentumEnd: () => {
      const span = headerSpan.value;
      const hidden = headerHidden.value;
      if (hidden > 0 && hidden < span) {
        headerHidden.value = withTiming(scrollY.value > span && hidden > span / 2 ? span : 0, {
          duration: 160,
        });
      }
    },
  });
  const headerStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -headerHidden.value }],
  }));
  const headerBackdropStyle = useAnimatedStyle(() => ({
    opacity: interpolate(scrollY.value, [0, HEADER_BACKDROP_SPAN], [0, 1], 'clamp'),
  }));

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
      const measured = Math.ceil(event.nativeEvent.layout.height);
      setContentHeight((current) => (Math.abs(current - measured) > 1 ? measured : current));
      if (effective === 'collapsed' || gestureActive.value) return;
      setPeekBody((current) => (Math.abs(current - measured) > 1 ? measured : current));
    },
    [effective, gestureActive]
  );

  // Gated like `peekBody`, and for the same reason: the collapsed header is the taller one-line
  // summary, and letting it feed `peek` would size the summary detent for a row it does not show.
  const measureHeader = useCallback(
    (event: LayoutChangeEvent) => {
      if (effective === 'collapsed' || gestureActive.value) return;
      const measured = Math.ceil(event.nativeEvent.layout.height);
      setMeasuredHeader((current) => (Math.abs(current - measured) > 1 ? measured : current));
    },
    [effective, gestureActive]
  );
  useEffect(() => {
    headerSpan.value = headerHeight;
    if (headerHidden.value > headerHeight) headerHidden.value = headerHeight;
    // Shared values are stable refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headerHeight]);

  // Dragging is not the only way to work a drawer: assistive tech gets the same three stops, and a
  // tap on the grip or the header asks for the next one up.
  const step = useCallback(
    (delta: number) => {
      const index = detents.indexOf(detent);
      const next = detents[Math.min(detents.length - 1, Math.max(0, index + delta))];
      if (next !== detent) onDetentChange(next);
    },
    [detent, detents, onDetentChange]
  );

  const expand = useCallback(() => step(1), [step]);

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
            <Pressable
              accessibilityRole="adjustable"
              accessibilityLabel="Panel size"
              accessibilityValue={{ text: DETENT_LABEL[detent] }}
              accessibilityActions={ADJUST_ACTIONS}
              onAccessibilityAction={(event) =>
                step(event.nativeEvent.actionName === 'increment' ? 1 : -1)
              }
              onPress={expand}
              style={styles.grip}
            >
              <Animated.View
                style={[styles.gripBar, { backgroundColor: chrome.seg }, gripBarStyle]}
              />
            </Pressable>
          </GestureDetector>
        ) : gripSpace ? (
          <View style={styles.grip} testID="map-drawer-grip-space">
            <Animated.View
              style={[styles.gripBar, { backgroundColor: chrome.seg }, gripBarStyle]}
            />
          </View>
        ) : null}

        <GestureDetector gesture={pans.body}>
          <View style={styles.body}>
            {/* Before the list, so it is read first; floated over it, so rows pass beneath. */}
            {header ? (
              <GestureDetector gesture={pans.header}>
                <Animated.View
                  onLayout={measureHeader}
                  style={[styles.header, headerStyle]}
                  testID="map-drawer-header"
                >
                  <Animated.View
                    pointerEvents="none"
                    style={[
                      StyleSheet.absoluteFill,
                      styles.headerBackdrop,
                      { backgroundColor: chrome.island, borderBottomColor: chrome.islandBorder },
                      headerBackdropStyle,
                    ]}
                  />
                  {/* Not an accessibility element itself: what is inside it (the summary, the
                      add button) is, and the grip already offers the same step to assistive tech. */}
                  <Pressable accessible={false} onPress={expand}>
                    <DrawerProgressContext.Provider value={progress}>
                      {header}
                    </DrawerProgressContext.Provider>
                  </Pressable>
                </Animated.View>
              </GestureDetector>
            ) : null}
            <GestureDetector gesture={nativeScroll}>
              <Animated.ScrollView
                ref={scrollRef}
                // iOS bounces a ScrollView vertically even when its content fits, which made the
                // ME panel — a body that always fits its own detent — feel like a list that had
                // somewhere to go and then sprang back. And a list that does scroll does not bounce
                // either: pulling down past its top is the drawer's (see the list pan), and a
                // bounce there would be the list and the drawer both answering the same pull.
                alwaysBounceVertical={false}
                bounces={false}
                overScrollMode="never"
                // A body that fits the detent it is in cannot scroll, rather than scrolling by
                // whatever the pixel grid happens to leave over. The heights are derived from the
                // body's own measurement, so at rest that slack is a rounding error — but a
                // ScrollView will still let you pull on a third of a point and bounce it back,
                // which is a panel twitching for a reason nobody can see.
                scrollEnabled={listScrolls}
                onScroll={scrollHandler}
                scrollEventThrottle={16}
                showsVerticalScrollIndicator={false}
                style={styles.body}
                contentContainerStyle={[styles.bodyContent, { paddingTop: headerHeight }]}
              >
                {/* Measured at its natural height — that measurement is what `peek` derives from. */}
                <View onLayout={measureBody}>
                  <DrawerProgressContext.Provider value={progress}>
                    {children}
                  </DrawerProgressContext.Provider>
                </View>
              </Animated.ScrollView>
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
    // A header that has slid up out of the way must leave under the grip, not over it.
    overflow: 'hidden',
  },
  header: {
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
    zIndex: 1,
  },
  headerBackdrop: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  bodyContent: {
    flexGrow: 1,
  },
});
