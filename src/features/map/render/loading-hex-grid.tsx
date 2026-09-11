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

/**
 * The unloaded world: the exploration grid, drawn analytically, under everything the map has
 * actually built.
 *
 * It is mounted for as long as the ladder is drawing cells at all, not only while a build is in
 * flight, which is the answer to "they are not visible until you drop a zoom". A region covers
 * about three viewports; pull back past its edge and what is beyond it used to be bare background
 * until the gesture ENDED, a build started, and only then a skeleton appeared over the hole. The
 * lattice now already extends well past the built region, so zooming out reveals grid rather than
 * nothing, and the region bitmap — which is opaque — hides it everywhere it has real data.
 *
 * Only the SWEEP is conditional. A settled lattice is a static draw, so Skia has nothing to
 * repaint; starting the shimmer would otherwise pin a full-screen shader to the display's refresh
 * rate forever, on a phone whose whole job is to still be alive in six hours.
 */
export function LoadingHexGrid({
  rect,
  lattice,
  loading,
  reducedMotion,
  ink,
}: {
  /** Where to draw, anchor-space px. Generously larger than the view: see `loadingViewRect`. */
  rect: { x: number; y: number; width: number; height: number };
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
  // The shader's origin is relative to the Group's translation, which puts the rect at 0,0.
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

  if (!effect) return null;

  return (
    <Group transform={[{ translateX: rect.x }, { translateY: rect.y }]}>
      <Rect x={0} y={0} width={rect.width} height={rect.height}>
        <Shader source={effect} uniforms={uniforms} />
      </Rect>
    </Group>
  );
}
