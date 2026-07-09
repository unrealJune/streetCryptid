'use no memo'; // react-compiler: keep it away from Skia/Reanimated JSI objects

import { Canvas, Group, Image as SkiaImage } from '@shopify/react-native-skia';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import {
  cancelAnimation,
  Easing,
  runOnJS,
  useAnimatedReaction,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withDecay,
  withTiming,
} from 'react-native-reanimated';

import {
  applyViewTransform,
  scaleFor,
  viewTransformFor,
  worldToScreen,
  type ViewTransform,
} from '../core/camera';
import {
  applyPan,
  applyPinch,
  clampTranslation,
  transformDistanceSq,
  translationRange,
} from '../core/gesture';
import type { CameraState, MapReadout, Viewport, WorldRect } from '../core/types';
import type { MapRegion } from '../engine/map-engine';
import { useMapEngine } from '../hooks/use-map-engine';
import { makeHexImage, makeLutImage, makeMaskImage, renderRegionImage } from './region-shader';
import { YouLocator } from './you-locator';

/** Region crossfade duration (ms) — new bitmap fades in over the old one. */
const CROSSFADE_MS = 200;
/** Movement (screen px, pan-equivalent) between mid-gesture prefetch checks. */
const PREFETCH_STRIDE_PX = 90;
/**
 * How far ahead of the motion to aim a prefetch build, in frames of current
 * velocity ≈ one build latency (~300 ms) — so a build lands roughly where the
 * camera IS by then, not where it was when the build started.
 */
const PREFETCH_LEAD_FRAMES = 18;
const PREFETCH_LEAD_MAX_PX = 900;
/** Fling below this speed (px/s) settles immediately instead of decaying. */
const MIN_FLING_SPEED = 50;
/** Double-tap zoom-in factor and animation length. */
const DOUBLE_TAP_FACTOR = 2;
const DOUBLE_TAP_MS = 260;

interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * On-screen rect (logical px) of a world rect as seen from a fixed anchor camera.
 * All layers are drawn in this single anchor space, so the shared live transform
 * places every one of them consistently — no per-region re-anchoring.
 */
function anchorRect(rect: WorldRect, anchor: CameraState, viewport: Viewport): ScreenRect {
  const [x, y] = worldToScreen(anchor, viewport, [rect.minX, rect.minY]);
  const s = scaleFor(anchor.zoom);
  return { x, y, width: (rect.maxX - rect.minX) * s, height: (rect.maxY - rect.minY) * s };
}

/**
 * The full-bleed interactive map.
 *
 * Rendering model: every region is rasterized ONCE (GPU dot-field shader) into a
 * static bitmap, drawn in one fixed session-anchor space. The whole visual state
 * is a single anchor-space transform p′ = k·p + t held in Reanimated shared
 * values and mutated ONLY on the UI thread: gestures compose into it exactly
 * (see core/gesture.ts), flings decay it, and double-taps animate it. React
 * never writes it back — commits flow one way (UI → JS) purely to decide which
 * data region to build. So a build landing, a prefetch swap, or any re-render
 * physically cannot move the map under the user's finger.
 *
 * Two layers are kept during a rebuild — the outgoing bitmap crossfades under
 * the incoming one (UI-thread opacity tween; no re-rasterization) — so a region
 * swap is a dissolve and the map is never blank.
 */
export function MapView({
  onReadout,
}: {
  /** Surfaces the coverage/place readout to the surrounding chrome. */
  onReadout?: (readout: MapReadout) => void;
}) {
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const reducedMotion = useReducedMotion();
  const {
    theme,
    region,
    anchor,
    limits,
    hexRadius,
    you,
    home,
    coverage,
    placeName,
    commit,
    prefetchAt,
  } = useMapEngine(viewport);

  // ── The one live view transform (anchor space → screen), UI-thread-owned ──
  const k = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  /** Outstanding fling decay animations (x + y); commit when the last ends. */
  const decaysLeft = useSharedValue(0);
  /** Transform at the last prefetch check, to gate by movement. */
  const lastPrefetch = useSharedValue<ViewTransform>({ k: 1, tx: 0, ty: 0 });

  // Mask/hex textures per region; LUT per theme. Kept for both the current region
  // and the outgoing one so each can be (re)rendered independently.
  const maskImage = useMemo(() => (region ? makeMaskImage(region) : null), [region]);
  const hexImage = useMemo(() => (region ? makeHexImage(region) : null), [region]);
  const lutImage = useMemo(() => makeLutImage(theme.canvas), [theme]);

  // Region transition (derive-state pattern): the new bitmap fades in over the
  // outgoing one. Opacity is a UI-thread tween — the bitmaps themselves are
  // never re-rendered for it. The outgoing layer is RETAINED (not just for the
  // fade) as the coverage fallback until the next region replaces it, exactly
  // like a tile map keeps stale tiles under fresh ones.
  const curOpacity = useSharedValue(1);
  const [track, setTrack] = useState<{
    cur: MapRegion | null;
    prev: MapRegion | null;
    seq: number;
  }>({ cur: null, prev: null, seq: 0 });
  if (region !== track.cur) {
    curOpacity.value = 0; // start hidden this frame (no flash); tween starts post-commit
    setTrack((t) => ({ cur: region, prev: t.cur, seq: t.seq + 1 }));
  }

  // A state tick per completed crossfade: guarantees the canvas paints the
  // final (fully opaque) frame even where shared-value updates alone don't
  // schedule a web repaint — without it a freshly loaded map can sit blank
  // until the first user input.
  const [, setFadeTick] = useState(0);
  const bumpFadeTick = () => setFadeTick((n) => n + 1);

  useEffect(() => {
    if (!track.cur) return;
    curOpacity.value = withTiming(1, { duration: reducedMotion ? 0 : CROSSFADE_MS }, (fin) => {
      if (fin) runOnJS(bumpFadeTick)();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.seq]);

  const prevMask = useMemo(() => (track.prev ? makeMaskImage(track.prev) : null), [track.prev]);
  const prevHex = useMemo(() => (track.prev ? makeHexImage(track.prev) : null), [track.prev]);

  const curImage = useMemo(() => {
    if (!track.cur || !maskImage || !hexImage || !lutImage) return null;
    return renderRegionImage({
      region: track.cur,
      palette: theme.canvas,
      hexRadius,
      maskImage,
      hexImage,
      lutImage,
    });
  }, [track.cur, theme, hexRadius, maskImage, hexImage, lutImage]);

  const prevImage = useMemo(() => {
    if (!track.prev || !prevMask || !prevHex || !lutImage) return null;
    return renderRegionImage({
      region: track.prev,
      palette: theme.canvas,
      hexRadius,
      maskImage: prevMask,
      hexImage: prevHex,
      lutImage,
    });
  }, [track.prev, theme, hexRadius, prevMask, prevHex, lutImage]);

  const curRect = useMemo(
    () => (track.cur && viewport ? anchorRect(track.cur.spec.rect, anchor, viewport) : null),
    [track.cur, anchor, viewport]
  );
  const prevRect = useMemo(
    () => (track.prev && viewport ? anchorRect(track.prev.spec.rect, anchor, viewport) : null),
    [track.prev, anchor, viewport]
  );
  const youAnchor = useMemo(
    () => (viewport ? worldToScreen(anchor, viewport, home) : null),
    [anchor, viewport, home]
  );

  useEffect(() => {
    onReadout?.({ coverage, placeName });
  }, [coverage, placeName, onReadout]);

  // Viewport resize (rotation, window resize): anchor-space px depend on the
  // viewport, so re-express the current camera in the new space. The only place
  // React ever writes the transform — gestures don't survive a resize anyway.
  const prevViewportRef = useRef<Viewport | null>(null);
  useEffect(() => {
    if (!viewport) return;
    const prev = prevViewportRef.current;
    prevViewportRef.current = viewport;
    if (!prev) return;
    const cam = applyViewTransform(anchor, prev, { k: k.value, tx: tx.value, ty: ty.value });
    const t = viewTransformFor(anchor, viewport, cam);
    k.value = t.k;
    tx.value = t.tx;
    ty.value = t.ty;
    commit(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport, anchor]);

  // Mid-gesture/fling prefetch: whenever the view has moved ~a stride since the
  // last check, request a region for a point LED ahead along the motion (about
  // one build latency), so the build lands where the camera will be. Uniform
  // across drags, flings, wheel zooms, and double-tap animations — anything
  // that moves the transform.
  useAnimatedReaction(
    () => ({ k: k.value, tx: tx.value, ty: ty.value }),
    (t, prev) => {
      if (!limits || !prev) return;
      if (transformDistanceSq(t, lastPrefetch.value) < PREFETCH_STRIDE_PX * PREFETCH_STRIDE_PX)
        return;
      lastPrefetch.value = t;
      let dx = (t.tx - prev.tx) * PREFETCH_LEAD_FRAMES;
      let dy = (t.ty - prev.ty) * PREFETCH_LEAD_FRAMES;
      const lead = Math.hypot(dx, dy);
      if (lead > PREFETCH_LEAD_MAX_PX) {
        dx *= PREFETCH_LEAD_MAX_PX / lead;
        dy *= PREFETCH_LEAD_MAX_PX / lead;
      }
      runOnJS(prefetchAt)(clampTranslation({ k: t.k, tx: t.tx + dx, ty: t.ty + dy }, limits));
    },
    [prefetchAt, limits]
  );

  const composedGesture = useMemo(() => {
    if (!limits) return Gesture.Tap().enabled(false);

    const stopFling = () => {
      'worklet';
      cancelAnimation(tx);
      cancelAnimation(ty);
      cancelAnimation(k);
      decaysLeft.value = 0;
    };

    const commitNow = () => {
      'worklet';
      runOnJS(commit)({ k: k.value, tx: tx.value, ty: ty.value });
    };

    const pan = Gesture.Pan()
      .maxPointers(2)
      .onBegin(stopFling)
      .onChange((e) => {
        const t = applyPan(
          { k: k.value, tx: tx.value, ty: ty.value },
          e.changeX,
          e.changeY,
          limits
        );
        tx.value = t.tx;
        ty.value = t.ty;
      })
      .onEnd((e) => {
        const speed = Math.hypot(e.velocityX, e.velocityY);
        if (speed < MIN_FLING_SPEED) {
          commitNow();
          return;
        }
        const kNow = k.value;
        const [txLo, txHi] = translationRange(kNow, limits.boundsX, limits.boundsW, limits.viewW);
        const [tyLo, tyHi] = translationRange(kNow, limits.boundsY, limits.boundsH, limits.viewH);
        const onDecayEnd = (finished?: boolean) => {
          'worklet';
          decaysLeft.value -= 1;
          if (finished && decaysLeft.value === 0) commitNow();
        };
        decaysLeft.value = 2;
        tx.value = withDecay({ velocity: e.velocityX, clamp: [txLo, txHi] }, onDecayEnd);
        ty.value = withDecay({ velocity: e.velocityY, clamp: [tyLo, tyHi] }, onDecayEnd);
      });

    const pinch = Gesture.Pinch()
      .onBegin(stopFling)
      .onChange((e) => {
        const t = applyPinch(
          { k: k.value, tx: tx.value, ty: ty.value },
          e.scaleChange,
          e.focalX,
          e.focalY,
          limits
        );
        k.value = t.k;
        tx.value = t.tx;
        ty.value = t.ty;
      })
      .onEnd(commitNow);

    const doubleTap = Gesture.Tap()
      .numberOfTaps(2)
      .maxDuration(260)
      .onEnd((e, success) => {
        if (!success) return;
        stopFling();
        const from: ViewTransform = { k: k.value, tx: tx.value, ty: ty.value };
        const to = applyPinch(from, DOUBLE_TAP_FACTOR, e.x, e.y, limits);
        // Linear interpolation of (k, tx, ty) with one shared curve keeps the
        // tapped point exactly fixed for the whole animation.
        const cfg = { duration: DOUBLE_TAP_MS, easing: Easing.out(Easing.cubic) };
        k.value = withTiming(to.k, cfg);
        tx.value = withTiming(to.tx, cfg);
        ty.value = withTiming(to.ty, cfg, (finished) => {
          if (finished) runOnJS(commit)(to);
        });
      });

    return Gesture.Race(doubleTap, Gesture.Simultaneous(pan, pinch));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limits, commit, prefetchAt]);

  // Desktop web: wheel / trackpad zoom at the cursor, like Google Maps. RN Web's
  // <View> doesn't forward an onWheel prop to the DOM node, so bind a non-passive
  // native 'wheel' listener to the container element directly.
  const containerRef = useRef<View | null>(null);
  const wheelCommitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (Platform.OS !== 'web' || !limits) return;
    const node = containerRef.current as unknown as HTMLElement | null;
    if (!node || typeof node.addEventListener !== 'function') return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = node.getBoundingClientRect();
      const factor = Math.pow(2, -e.deltaY / 480); // one notch (±100) ≈ ±15% scale
      const t = applyPinch(
        { k: k.value, tx: tx.value, ty: ty.value },
        factor,
        e.clientX - rect.left,
        e.clientY - rect.top,
        limits
      );
      k.value = t.k;
      tx.value = t.tx;
      ty.value = t.ty;
      if (wheelCommitTimer.current) clearTimeout(wheelCommitTimer.current);
      wheelCommitTimer.current = setTimeout(() => commit(t), 180);
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limits, commit]);

  // The live transform as Skia ops (p → scale then translate).
  const transform = useDerivedValue(() => [
    { translateX: tx.value },
    { translateY: ty.value },
    { scale: k.value },
  ]);
  // Derived (not the raw shared value): Skia's prop binding tracks derived
  // values reliably on every platform, including web.
  const curOpacityValue = useDerivedValue(() => curOpacity.value);

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width > 0 && height > 0) {
      setViewport((v) => (v && v.width === width && v.height === height ? v : { width, height }));
    }
  };

  return (
    <GestureDetector gesture={composedGesture}>
      <View
        ref={containerRef}
        style={[styles.fill, { backgroundColor: theme.chrome.bg }]}
        onLayout={onLayout}
        testID="map-view"
      >
        {viewport && (
          <Canvas style={styles.fill}>
            <Group transform={transform}>
              {prevImage && prevRect && (
                <SkiaImage
                  image={prevImage}
                  x={prevRect.x}
                  y={prevRect.y}
                  width={prevRect.width}
                  height={prevRect.height}
                  fit="fill"
                />
              )}
              {curImage && curRect && (
                <SkiaImage
                  image={curImage}
                  x={curRect.x}
                  y={curRect.y}
                  width={curRect.width}
                  height={curRect.height}
                  fit="fill"
                  opacity={curOpacityValue}
                />
              )}
              {you && youAnchor && (
                <YouLocator x={youAnchor[0]} y={youAnchor[1]} accent={theme.canvas.accent} />
              )}
            </Group>
          </Canvas>
        )}
        {you && (
          <View
            pointerEvents="none"
            style={[
              styles.youChip,
              { left: you[0] + 16, top: you[1] - 10, backgroundColor: theme.chrome.island },
            ]}
          >
            <Text style={[styles.youText, { color: theme.chrome.amber }]}>YOU</Text>
          </View>
        )}
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  youChip: {
    position: 'absolute',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  youText: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 13,
    letterSpacing: 0.5,
  },
});
