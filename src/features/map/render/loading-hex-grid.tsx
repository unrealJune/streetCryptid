import { Group, Rect, Shader, Skia } from '@shopify/react-native-skia';
import { useEffect, useMemo } from 'react';
import {
  cancelAnimation,
  Easing,
  useDerivedValue,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import type { ScreenHexLattice } from '../core/hex-lattice';
import type { Rgb } from '../core/types';
import { LOADING_HEX_SKSL } from './loading-hex-shader';

/** One full traverse of the sweep's wavelength. */
const SWEEP_MS = 2600;

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * `outer` with `hole` taken out of it, as up to four rectangles, all relative to `outer`'s own
 * origin. Rectangles are what make this worth doing: Skia culls a draw whose bounds miss the
 * canvas without ever running its shader, so once the built region covers the screen the whole
 * skeleton costs four rejected bounds checks. Any hole-shaped clip would still have shaded every
 * pixel of the screen to throw the result away.
 */
export function punchRect(outer: Box, hole: Box | null): readonly Box[] {
  const whole = [{ x: 0, y: 0, width: outer.width, height: outer.height }];
  if (!hole) return whole;
  const clampX = (value: number) => Math.min(Math.max(value - outer.x, 0), outer.width);
  const clampY = (value: number) => Math.min(Math.max(value - outer.y, 0), outer.height);
  const left = clampX(hole.x);
  const right = clampX(hole.x + hole.width);
  const top = clampY(hole.y);
  const bottom = clampY(hole.y + hole.height);
  if (right <= left || bottom <= top) return whole;
  const band = bottom - top;
  return [
    { x: 0, y: 0, width: outer.width, height: top },
    { x: 0, y: bottom, width: outer.width, height: outer.height - bottom },
    { x: 0, y: top, width: left, height: band },
    { x: right, y: top, width: outer.width - right, height: band },
  ].filter((box) => box.width > 0 && box.height > 0);
}

/**
 * The unloaded world: the exploration grid, drawn analytically, under everything the map has
 * actually built.
 *
 * It is mounted for as long as the ladder is drawing cells at all, not only while a build is in
 * flight, which is the answer to "they are not visible until you drop a zoom". A region covers
 * about three viewports; pull back past its edge and what is beyond it used to be bare background
 * until the gesture ENDED, a build started, and only then a skeleton appeared over the hole. The
 * lattice now already extends well past the built region, so zooming out reveals grid rather than
 * nothing.
 *
 * Being mounted that much is only affordable because it is not DRAWN that much. The region bitmap
 * is opaque, so every pixel of skeleton under it was shaded and then covered — a full-screen pass
 * per frame, for ever, to produce nothing. `covered` is that bitmap's rect, and the skeleton is cut
 * around it; the pieces that remain are off-canvas whenever the map has the screen covered, which
 * is the ordinary case.
 *
 * Only the SWEEP is conditional. A settled lattice is a static draw, so Skia has nothing to
 * repaint; starting the shimmer would otherwise pin a shader to the display's refresh rate
 * forever, on a phone whose whole job is to still be alive in six hours.
 */
export function LoadingHexGrid({
  rect,
  covered,
  lattice,
  loading,
  reducedMotion,
  ink,
}: {
  /** Where to draw, anchor-space px. Generously larger than the view: see `loadingRect`. */
  rect: Box;
  /**
   * Anchor-space rect the built layer is currently covering OPAQUELY, cut out of the draw. Null
   * while the reveal wipe is running, which is exactly when those pixels are see-through and the
   * skeleton underneath is the thing being revealed from.
   */
  covered: Box | null;
  lattice: ScreenHexLattice;
  /** A build is in flight — run the sweep. */
  loading: boolean;
  reducedMotion: boolean;
  ink: Rgb;
}) {
  const phase = useSharedValue(0.5);
  const animate = loading && !reducedMotion;
  // Plain render-time state, not a shared value: how bright the sweep is follows props, and only
  // its POSITION is animated. Reduced motion still says "loading" — with a crest that sits still,
  // which is the same bargain the old grid struck.
  const sweep = animate ? 1 : loading ? 0.45 : 0;
  useEffect(() => {
    if (!animate) {
      cancelAnimation(phase);
      return;
    }
    phase.value = 0;
    phase.value = withRepeat(
      withTiming(1, { duration: SWEEP_MS, easing: Easing.linear }),
      -1,
      false
    );
    return () => cancelAnimation(phase);
  }, [animate, phase]);

  const effect = useMemo(() => {
    const compiled = Skia.RuntimeEffect.Make(LOADING_HEX_SKSL);
    if (!compiled) console.warn('[map] loading hex shader unavailable');
    return compiled;
  }, []);
  // Normalise on the JS thread: an arrow passed to .map() inside the worklet is
  // captured as a remote function, and calling one on the UI runtime is fatal.
  const uInk = useMemo(() => [ink[0] / 255, ink[1] / 255, ink[2] / 255], [ink]);
  // The shader's origin is relative to the Group's translation, which puts the rect at 0,0 — and
  // so are the pieces, which is what lets them all share one set of uniforms.
  const originX = lattice.originX - rect.x;
  const originY = lattice.originY - rect.y;
  const uniforms = useDerivedValue(() => ({
    uOrigin: [originX, originY],
    uRadius: Math.max(0.5, lattice.radius),
    uRot: lattice.rotation,
    uWidth: Math.max(0.01, lattice.strokeWidth),
    uPhase: phase.value,
    uSweep: sweep,
    uInk,
  }));
  const pieces = useMemo(() => punchRect(rect, covered), [rect, covered]);

  if (!effect) return null;

  return (
    <Group transform={[{ translateX: rect.x }, { translateY: rect.y }]}>
      {pieces.map((piece, index) => (
        <Rect key={index} x={piece.x} y={piece.y} width={piece.width} height={piece.height}>
          <Shader source={effect} uniforms={uniforms} />
        </Rect>
      ))}
    </Group>
  );
}
