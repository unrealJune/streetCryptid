'use no memo'; // Reanimated shared values are mutable UI-runtime state, not React state.

import { useCallback } from 'react';
import {
  cancelAnimation,
  useDerivedValue,
  useSharedValue,
  withTiming,
  type WithTimingConfig,
} from 'react-native-reanimated';

import { IDENTITY_TRANSFORM, type ViewTransform } from '../core/camera';

/** One clock, not three independently timestamped timing animations. All writers run on UI. */
export function useMapTransform() {
  const base = useSharedValue(IDENTITY_TRANSFORM);
  const decayX = useSharedValue(0);
  const decayY = useSharedValue(0);
  const from = useSharedValue(IDENTITY_TRANSFORM);
  const to = useSharedValue(IDENTITY_TRANSFORM);
  const progress = useSharedValue(1);
  const timing = useSharedValue(false);
  const locating = useSharedValue(false);
  const decaysLeft = useSharedValue(0);

  const read = useCallback((): ViewTransform => {
    'worklet';
    if (!timing.value) return { k: base.value.k, tx: decayX.value, ty: decayY.value };
    const p = progress.value;
    if (p <= 0) return from.value;
    if (p >= 1) return to.value;
    return {
      k: from.value.k + (to.value.k - from.value.k) * p,
      tx: from.value.tx + (to.value.tx - from.value.tx) * p,
      ty: from.value.ty + (to.value.ty - from.value.ty) * p,
    };
  }, [base, decayX, decayY, from, to, progress, timing]);

  const set = useCallback(
    (value: ViewTransform) => {
      'worklet';
      base.value = value;
      decayX.value = value.tx;
      decayY.value = value.ty;
      timing.value = false;
    },
    [base, decayX, decayY, timing]
  );

  const stop = useCallback(() => {
    'worklet';
    const displayed = read();
    cancelAnimation(progress);
    cancelAnimation(decayX);
    cancelAnimation(decayY);
    decaysLeft.value = 0;
    locating.value = false;
    set(displayed);
    return displayed;
  }, [read, progress, decayX, decayY, decaysLeft, locating, set]);

  const animate = useCallback(
    (
      target: ViewTransform,
      config: WithTimingConfig,
      onFinished?: (finished?: boolean) => void,
      locate = false
    ) => {
      'worklet';
      from.value = stop();
      to.value = target;
      progress.value = 0;
      locating.value = locate;
      timing.value = true;
      progress.value = withTiming(1, config, (finished) => {
        if (finished) locating.value = false;
        onFinished?.(finished);
      });
    },
    [from, to, progress, locating, timing, stop]
  );

  const transform = useDerivedValue(read);
  const k = useDerivedValue(() => transform.value.k);
  const tx = useDerivedValue(() => transform.value.tx);
  const ty = useDerivedValue(() => transform.value.ty);
  return { transform, k, tx, ty, read, set, stop, animate, decayX, decayY, decaysLeft, locating };
}
