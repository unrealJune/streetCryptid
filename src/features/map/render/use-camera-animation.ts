'use no memo'; // react-compiler: keep it away from the shared values its worklets capture

import { useCallback } from 'react';
import { useSharedValue, type SharedValue } from 'react-native-reanimated';

import type { ViewTransform } from '../core/camera';
import { cameraAnimationProgress, interpolateViewTransform } from '../core/gesture';

export interface CameraAnimation {
  /** True while a locate fly-to runs; the prefetch reaction stands down for it. */
  readonly locating: SharedValue<boolean>;
  /**
   * Worklet: animate the view transform to `to`, every component on ONE clock.
   *
   * Replaces any running camera animation, starting from the transform on screen now. Zero
   * `durationMs` (reduced motion) lands at once. `onFinished` runs on the UI thread only when the
   * animation reaches `to`; an interrupted one never calls it, so nobody commits a destination the
   * camera never reached.
   */
  readonly animate: (
    to: ViewTransform,
    durationMs: number,
    easing: (t: number) => number,
    onFinished?: () => void,
    locate?: boolean
  ) => void;
  /** Worklet: stop a running camera animation where it is. */
  readonly stop: () => void;
}

/**
 * Camera animations for the map's `(k, tx, ty)` view transform, driven by one UI-thread frame loop.
 *
 * Not three `withTiming`s: each of those reads its own start time when it is assigned, and outside
 * Reanimated's frame loop (a gesture callback, a JS hop) those reads differ by microseconds. The
 * skew is invisible near the anchor and thousands of px half a world from it — see
 * {@link interpolateViewTransform}. Here every frame computes ONE progress from the frame
 * timestamp and writes all three from it.
 *
 * Anything else that writes the transform (a gesture, a resize) must call `stop` first, or the next
 * frame overwrites it: unlike a Reanimated animation, assigning a shared value does not cancel this.
 */
export function useCameraAnimation(
  k: SharedValue<number>,
  tx: SharedValue<number>,
  ty: SharedValue<number>
): CameraAnimation {
  /** Bumped by every start and stop; a frame from an older animation sees it and ends. */
  const generation = useSharedValue(0);
  const locating = useSharedValue(false);

  const stop = useCallback(() => {
    'worklet';
    generation.value += 1;
    locating.value = false;
  }, [generation, locating]);

  const animate = useCallback(
    (
      to: ViewTransform,
      durationMs: number,
      easing: (t: number) => number,
      onFinished?: () => void,
      locate = false
    ) => {
      'worklet';
      generation.value += 1;
      const token = generation.value;
      const from: ViewTransform = { k: k.value, tx: tx.value, ty: ty.value };
      locating.value = locate;

      const write = (t: ViewTransform) => {
        k.value = t.k;
        tx.value = t.tx;
        ty.value = t.ty;
      };

      if (durationMs <= 0) {
        write(to);
        locating.value = false;
        onFinished?.();
        return;
      }

      let startedAt = -1;
      const frame = (timestamp: number) => {
        if (generation.value !== token) return;
        if (startedAt < 0) startedAt = timestamp;
        const p = cameraAnimationProgress(timestamp - startedAt, durationMs, easing);
        write(interpolateViewTransform(from, to, p));
        if (p < 1) {
          requestAnimationFrame(frame);
          return;
        }
        locating.value = false;
        onFinished?.();
      };
      requestAnimationFrame(frame);
    },
    [generation, locating, k, tx, ty]
  );

  return { locating, animate, stop };
}
