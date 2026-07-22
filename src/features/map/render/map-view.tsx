'use no memo'; // react-compiler: keep it away from Skia/Reanimated JSI objects

import {
  Canvas,
  Circle,
  Group,
  Image as SkiaImage,
  ImageShader,
  Path,
  Rect,
  Shader,
  Skia,
} from '@shopify/react-native-skia';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
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
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import {
  applyViewTransform,
  scaleFor,
  viewTransformFor,
  worldToScreen,
  type ViewTransform,
} from '../core/camera';
import { rgbToHex } from '../core/color';
import {
  applyPan,
  applyPinch,
  clampTranslation,
  transformDistanceSq,
  translationRange,
} from '../core/gesture';
import type { LocationFix } from '@/features/social/core/types';

import type {
  CameraState,
  LatLon,
  MapReadout,
  ScreenPoint,
  Viewport,
  WorldPoint,
  WorldRect,
} from '../core/types';
import { clusterMarkers } from '../core/marker-clusters';
import type { MapRegion } from '../engine/map-engine';
import { useMapEngine } from '../hooks/use-map-engine';
import { latLonToWorld } from '../core/mercator';
import { FriendLocator } from './friend-locator';
import { FriendLocatorStack } from './friend-locator-stack';
import {
  makeCellStateImage,
  makeLutImage,
  makeMaskImage,
  renderRegionImage,
} from './region-shader';
import { getRevealMaskEffect } from './reveal-mask-shader';
import { prevRectUniform, REVEAL_TARGET } from './reveal-mask';
import { YouLocator } from './you-locator';

/** Crossfade duration (ms) — fallback only, when a bundle lacks its textures. */
const CROSSFADE_MS = 200;
/**
 * Hex-by-hex load-in duration (ms) for a region swap. The shader swaps in
 * whatever the previous layer already covered instantly and hex-loads only the
 * newly-exposed ground around it, each hex flaring as it appears — so covered
 * panning stays seamless and only new territory animates. Long enough that the
 * per-hex pop reads.
 */
const REVEAL_MS = 640;
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
/**
 * How many friend locations to warm during idle (selected + nearest). Bounded so
 * the tile LRU isn't thrashed out of the region the user is actually looking at.
 */
const FRIEND_PREFETCH_MAX = 4;
/** Double-tap zoom-in factor and animation length. */
const DOUBLE_TAP_FACTOR = 2;
const DOUBLE_TAP_MS = 260;

interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MapFriendLocation {
  id: string;
  handle: string;
  sigil: string;
  cryptidName?: string;
  color: string;
  location: LatLon;
  history: readonly LatLon[];
  historyCount: number;
  latestTs: number;
  stale?: boolean;
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
 * Two layers are kept during a rebuild — the incoming region hex-loads in over
 * the retained outgoing one (a UI-thread wipe that swaps covered ground in
 * instantly and only animates newly-exposed area; no re-rasterization) — so a
 * region swap reads as the world drawing itself in and the map is never blank.
 */
export function MapView({
  onReadout,
  initialCenter = null,
  selfLocation = null,
  selfFix = null,
  selfHistory = [],
  selfSelected = false,
  friends = [],
  selectedFriendId = null,
  explorationEnabled = true,
  accessibilityLabel,
  onSelectSelf,
  onSelectFriend,
}: {
  /** Surfaces the coverage/place readout to the surrounding chrome. */
  onReadout?: (readout: MapReadout) => void;
  initialCenter?: LatLon | null;
  selfLocation?: LatLon | null;
  /** The full live self fix (accuracy + ts) — feeds live exploration. */
  selfFix?: LocationFix | null;
  selfHistory?: readonly LatLon[];
  selfSelected?: boolean;
  friends?: readonly MapFriendLocation[];
  selectedFriendId?: string | null;
  explorationEnabled?: boolean;
  accessibilityLabel?: string;
  onSelectSelf?: () => void;
  onSelectFriend?: (friendId: string) => void;
}) {
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const reducedMotion = useReducedMotion();

  // Friend locations to warm during idle: the selected friend first, then the
  // nearest fresh friends (the `friends` prop already arrives nearest-first),
  // capped and stale-filtered so tapping through to a friend lands warm without
  // evicting the region in view. Mapped to world space for the engine.
  const friendTargets = useMemo<readonly WorldPoint[]>(() => {
    const out: WorldPoint[] = [];
    const selected =
      selectedFriendId != null
        ? friends.find((f) => f.id === selectedFriendId && !f.stale)
        : undefined;
    if (selected) out.push(latLonToWorld(selected.location));
    for (const friend of friends) {
      if (out.length >= FRIEND_PREFETCH_MAX) break;
      if (friend.stale || friend.id === selectedFriendId) continue;
      out.push(latLonToWorld(friend.location));
    }
    return out;
  }, [friends, selectedFriendId]);

  const { theme, region, pending, anchor, limits, coverage, placeName, commit, prefetchAt } =
    useMapEngine(viewport, initialCenter, selfFix, friendTargets);

  // ── The one live view transform (anchor space → screen), UI-thread-owned ──
  const k = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  /** Outstanding fling decay animations (x + y); commit when the last ends. */
  const decaysLeft = useSharedValue(0);
  /** Transform at the last prefetch check, to gate by movement. */
  const lastPrefetch = useSharedValue<ViewTransform>({ k: 1, tx: 0, ty: 0 });
  const trailStrokeWidth = useDerivedValue(() => 2.5 / Math.max(0.001, k.value));
  const trailDotRadius = useDerivedValue(() => 2.8 / Math.max(0.001, k.value));

  const lutImage = useMemo(() => makeLutImage(theme.canvas), [theme]);

  // Build a region's mask + cell textures AND its bitmap together, once. On the
  // next swap the whole bundle slides into the outgoing (`prev`) slot instead of
  // being rebuilt — so each region is rasterized a single time, not twice per
  // swap (the outgoing rebuild was ~180ms of pure waste per region change).
  type RegionBundle = {
    region: MapRegion;
    image: ReturnType<typeof renderRegionImage>;
    /** The baked cell-state texture — reused by the loading reveal's alpha wipe. */
    cellImage: ReturnType<typeof makeCellStateImage>;
  };
  const curBundle = useMemo<RegionBundle | null>(() => {
    if (!region) return null;
    const maskImage = makeMaskImage(region);
    const cellImage = makeCellStateImage(region);
    if (!maskImage || !cellImage || !lutImage) return { region, image: null, cellImage: null };
    const image = renderRegionImage({
      region,
      palette: theme.canvas,
      maskImage,
      cellImage,
      lutImage,
      explorationEnabled,
    });
    return { region, image, cellImage };
  }, [region, theme, lutImage, explorationEnabled]);

  // Region transition (derive-state pattern): the new bitmap fades in over the
  // outgoing one. Opacity is a UI-thread tween — the bitmaps themselves are
  // never re-rendered for it. The outgoing layer is RETAINED (not just for the
  // fade) as the coverage fallback until the next region replaces it, exactly
  // like a tile map keeps stale tiles under fresh ones.
  const curOpacity = useSharedValue(1);
  // Reveal wipe front (uReveal): 1 = fully shown. Dropped to 0 when a cold
  // region lands, then animated to REVEAL_TARGET so its hexes fill in.
  const revealFront = useSharedValue(REVEAL_TARGET);
  const [track, setTrack] = useState<{
    cur: RegionBundle | null;
    prev: RegionBundle | null;
    seq: number;
    /** This swap is a cache-miss arrival — play the hex reveal, not the crossfade. */
    reveal: boolean;
  }>({ cur: null, prev: null, seq: 0, reveal: false });
  // Whether the current layer is mid-reveal — while true it draws through the
  // reveal shader (one cheap GPU pass); on completion it hands back to a plain
  // <Image>, so there is zero residual cost once settled. Set here in the
  // derive-during-render block (not an effect) alongside `track`.
  const [revealing, setRevealing] = useState(false);
  const endReveal = () => setRevealing(false);
  if (curBundle !== track.cur) {
    // Every swap hex-loads in: the shader masks off whatever the previous layer
    // already covered, so only newly-exposed ground animates (covered panning
    // stays seamless) — no all-at-once crossfade. The plain crossfade remains
    // only as a fallback when a bundle lacks its textures.
    const reveal = Boolean(curBundle?.image && curBundle?.cellImage);
    if (reveal) {
      revealFront.value = 0; // hexes start hidden; the wipe fills them in
      curOpacity.value = 1; // image is fully opaque — the mask controls visibility
      setRevealing(true);
    } else {
      curOpacity.value = 0; // start hidden this frame (no flash); tween starts post-commit
      setRevealing(false); // textureless fallback drops back to the <Image> crossfade
    }
    setTrack((t) => ({ cur: curBundle, prev: t.cur, seq: t.seq + 1, reveal }));
  }

  // A state tick per completed crossfade: guarantees the canvas paints the
  // final (fully opaque) frame even where shared-value updates alone don't
  // schedule a web repaint — without it a freshly loaded map can sit blank
  // until the first user input.
  const [, setFadeTick] = useState(0);
  const bumpFadeTick = () => setFadeTick((n) => n + 1);

  useEffect(() => {
    if (!track.cur) return;
    if (track.reveal) {
      curOpacity.value = 1;
      // Cancel any prior wipe so its (finished=false) callback can't end this
      // one — overlapping cold reveals are rare but must not cross-cancel.
      cancelAnimation(revealFront);
      revealFront.value = withTiming(
        REVEAL_TARGET,
        { duration: reducedMotion ? 0 : REVEAL_MS },
        (fin) => {
          if (fin) {
            runOnJS(endReveal)();
            runOnJS(bumpFadeTick)();
          }
        }
      );
    } else {
      curOpacity.value = withTiming(1, { duration: reducedMotion ? 0 : CROSSFADE_MS }, (fin) => {
        if (fin) runOnJS(bumpFadeTick)();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.seq]);

  // Already-built bitmaps — the outgoing layer reuses the bundle it was rendered
  // with, so no region is ever rasterized a second time.
  const curImage = track.cur?.image ?? null;
  const prevImage = track.prev?.image ?? null;
  /** Current region's cell texture — sampled by the reveal wipe for its alpha. */
  const curCellImage = track.cur?.cellImage ?? null;

  const revealEffect = useMemo(() => getRevealMaskEffect(), []);

  const curRect = useMemo(
    () => (track.cur && viewport ? anchorRect(track.cur.region.spec.rect, anchor, viewport) : null),
    [track.cur, anchor, viewport]
  );
  // SkRect twin of curRect for the reveal's ImageShaders — placed at the same
  // rect as the settled <Image>, so the wipe and the plain draw are pixel-aligned.
  const curRectSk = useMemo(
    () => (curRect ? Skia.XYWHRect(curRect.x, curRect.y, curRect.width, curRect.height) : null),
    [curRect]
  );
  const prevRect = useMemo(
    () =>
      track.prev && viewport ? anchorRect(track.prev.region.spec.rect, anchor, viewport) : null,
    [track.prev, anchor, viewport]
  );
  // The area the outgoing layer already covered — the reveal shader swaps these
  // pixels in instantly and only hex-loads the newly-exposed ground around them.
  const prevRectVec = useMemo(() => prevRectUniform(prevRect), [prevRect]);
  const revealUniforms = useDerivedValue(
    () => ({ uReveal: revealFront.value, uPrevRect: prevRectVec }),
    [prevRectVec]
  );

  // Loading skeleton: while a cold region is fetching over an uncovered area
  // (`pending`), a gently pulsing tint sits where the map will appear, so the
  // long network wait reads as "loading here" instead of a blank canvas. Cheap
  // by construction — no cell field is built for it — and mounted only while the
  // fetch is outstanding.
  const pendingRect = useMemo(
    () => (pending && viewport ? anchorRect(pending.rect, anchor, viewport) : null),
    [pending, anchor, viewport]
  );
  const skeletonPulse = useSharedValue(0);
  useEffect(() => {
    if (!pendingRect || reducedMotion) {
      skeletonPulse.value = reducedMotion ? 1 : 0;
      return;
    }
    skeletonPulse.value = 0;
    skeletonPulse.value = withRepeat(withTiming(1, { duration: 900 }), -1, true);
    return () => {
      cancelAnimation(skeletonPulse);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(pendingRect), reducedMotion]);
  const skeletonOpacity = useDerivedValue(() => 0.05 + 0.07 * skeletonPulse.value);
  // The wipe must EXPOSE the region, not flash over it: while revealing we hide
  // the retained prev layer and back the wipe with the loading tint at the
  // region's own rect, so unrevealed hexes read as "still loading" and the flash
  // brings the real tiles in over that backdrop instead of over visible tiles.
  const loadingRect = pendingRect ?? (revealing ? curRect : null);
  const selfAnchor = useMemo(
    () =>
      viewport && selfLocation
        ? worldToScreen(anchor, viewport, latLonToWorld(selfLocation))
        : null,
    [anchor, viewport, selfLocation]
  );
  const locatorAnchors = useMemo(() => {
    if (!viewport) return [];
    const anchoredFriends = friends.map((friend) => ({
      ...friend,
      kind: 'friend' as const,
      anchor: worldToScreen(anchor, viewport, latLonToWorld(friend.location)),
    }));
    return selfAnchor
      ? [
          ...anchoredFriends,
          {
            id: 'self',
            kind: 'self' as const,
            anchor: selfAnchor,
            color: rgbToHex(theme.canvas.accent),
          },
        ]
      : anchoredFriends;
  }, [anchor, friends, selfAnchor, theme.canvas.accent, viewport]);
  const locatorClusters = useMemo(() => clusterMarkers(locatorAnchors), [locatorAnchors]);
  const selfTrailPoints = useMemo(
    () =>
      viewport
        ? selfHistory.map((location) => worldToScreen(anchor, viewport, latLonToWorld(location)))
        : [],
    [anchor, selfHistory, viewport]
  );
  const selectedTrail = useMemo(() => {
    if (!viewport) return null;
    if (selfSelected) {
      return buildTrail(selfTrailPoints, `rgb(${theme.canvas.accent.join(', ')})`);
    }
    if (!selectedFriendId) return null;
    const friend = friends.find((candidate) => candidate.id === selectedFriendId);
    if (!friend) return null;
    const points = friend.history.map((location) =>
      worldToScreen(anchor, viewport, latLonToWorld(location))
    );
    return buildTrail(points, friend.color);
  }, [
    anchor,
    friends,
    selectedFriendId,
    selfSelected,
    selfTrailPoints,
    theme.canvas.accent,
    viewport,
  ]);
  useEffect(() => {
    const path = selectedTrail?.path;
    return () => path?.dispose();
  }, [selectedTrail]);

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
    <View
      ref={containerRef}
      style={[styles.fill, { backgroundColor: theme.chrome.bg }]}
      onLayout={onLayout}
      testID="map-view"
    >
      <GestureDetector gesture={composedGesture}>
        <View
          accessible={Boolean(accessibilityLabel)}
          accessibilityLabel={accessibilityLabel}
          accessibilityRole="image"
          style={styles.fill}
        >
          {viewport && (
            <Canvas style={styles.fill}>
              <Group transform={transform}>
                {loadingRect && (
                  <Rect
                    x={loadingRect.x}
                    y={loadingRect.y}
                    width={loadingRect.width}
                    height={loadingRect.height}
                    color={theme.chrome.island}
                    opacity={skeletonOpacity}
                  />
                )}
                {/* Retained coverage layer — stays under the reveal now: the wipe
                    swaps its pixels in instantly where prev already covered
                    (uPrevRect), so only the newly-exposed ground hex-loads in. */}
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
                {curImage &&
                  curRect &&
                  (revealing && revealEffect && curCellImage && curRectSk ? (
                    // Hex load-in: paint the finished bitmap through the reveal
                    // wipe (one cheap GPU pass). Pixels prev already covered swap
                    // in instantly; only new ground animates. Bounded to curRect;
                    // hands back to <Image> the instant the wipe completes.
                    <Rect x={curRect.x} y={curRect.y} width={curRect.width} height={curRect.height}>
                      <Shader source={revealEffect} uniforms={revealUniforms}>
                        <ImageShader image={curImage} rect={curRectSk} fit="fill" />
                        <ImageShader image={curCellImage} rect={curRectSk} fit="fill" />
                      </Shader>
                    </Rect>
                  ) : (
                    <SkiaImage
                      image={curImage}
                      x={curRect.x}
                      y={curRect.y}
                      width={curRect.width}
                      height={curRect.height}
                      fit="fill"
                      opacity={curOpacityValue}
                    />
                  ))}
                {selectedTrail ? (
                  <>
                    <Path
                      color={selectedTrail.color}
                      opacity={0.72}
                      path={selectedTrail.path}
                      strokeCap="round"
                      strokeJoin="round"
                      strokeWidth={trailStrokeWidth}
                      style="stroke"
                    />
                    {selectedTrail.points.map((point, index) => (
                      <Circle
                        color={selectedTrail.color}
                        cx={point[0]}
                        cy={point[1]}
                        key={`${point[0]}:${point[1]}:${index}`}
                        opacity={0.34 + (0.5 * (index + 1)) / selectedTrail.points.length}
                        r={trailDotRadius}
                      />
                    ))}
                  </>
                ) : null}
              </Group>
            </Canvas>
          )}
        </View>
      </GestureDetector>

      {viewport
        ? locatorClusters.map((cluster) => {
            if (cluster.length === 1) {
              const locator = cluster[0];
              if (locator.kind === 'self') {
                return (
                  <YouLocator
                    accent={theme.canvas.accent}
                    key="self"
                    onPress={() => onSelectSelf?.()}
                    panelColor={theme.chrome.island}
                    scale={k}
                    selected={selfSelected}
                    translateX={tx}
                    translateY={ty}
                    x={locator.anchor[0]}
                    y={locator.anchor[1]}
                  />
                );
              }
              return (
                <FriendLocator
                  color={locator.color}
                  handle={locator.handle}
                  key={locator.id}
                  onPress={() => onSelectFriend?.(locator.id)}
                  panelColor={theme.chrome.island}
                  scale={k}
                  selected={locator.id === selectedFriendId}
                  sigil={locator.sigil}
                  stale={locator.stale}
                  translateX={tx}
                  translateY={ty}
                  x={locator.anchor[0]}
                  y={locator.anchor[1]}
                />
              );
            }

            const anchorSum = cluster.reduce(
              (sum, locator) => [sum[0] + locator.anchor[0], sum[1] + locator.anchor[1]],
              [0, 0]
            );
            return (
              <FriendLocatorStack
                friends={cluster.map((locator) =>
                  locator.kind === 'self'
                    ? {
                        id: locator.id,
                        handle: 'YOU',
                        sigil: '',
                        color: locator.color,
                        selected: selfSelected,
                        self: true,
                      }
                    : {
                        ...locator,
                        selected: locator.id === selectedFriendId,
                      }
                )}
                key={cluster.map((locator) => `${locator.kind}:${locator.id}`).join(':')}
                onPress={(friendId) => onSelectFriend?.(friendId)}
                onPressSelf={() => onSelectSelf?.()}
                panelColor={theme.chrome.island}
                scale={k}
                translateX={tx}
                translateY={ty}
                x={anchorSum[0] / cluster.length}
                y={anchorSum[1] / cluster.length}
              />
            );
          })
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});

function buildTrail(points: readonly ScreenPoint[], color: string) {
  if (points.length === 0) return null;
  const path = Skia.Path.Make();
  path.moveTo(points[0][0], points[0][1]);
  for (const point of points.slice(1)) path.lineTo(point[0], point[1]);
  return { color, path, points };
}
