import { Group, Rect, Shader, Skia } from '@shopify/react-native-skia';
import { useEffect, useMemo } from 'react';
import {
  cancelAnimation,
  Easing,
  useDerivedValue,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import type { Rgb } from '../core/types';
import { LOADING_HEX_SKSL } from './loading-hex-shader';

export function LoadingHexGrid({
  rect,
  scale,
  reducedMotion,
  ink,
}: {
  rect: { x: number; y: number; width: number; height: number };
  scale: SharedValue<number>;
  reducedMotion: boolean;
  ink: Rgb;
}) {
  const phase = useSharedValue(0.5);
  useEffect(() => {
    phase.value = reducedMotion ? 0.5 : 0;
    if (!reducedMotion) {
      phase.value = withRepeat(withTiming(1, { duration: 1800, easing: Easing.linear }), -1, false);
    }
    return () => cancelAnimation(phase);
  }, [phase, reducedMotion]);
  const effect = useMemo(() => {
    const compiled = Skia.RuntimeEffect.Make(LOADING_HEX_SKSL);
    if (!compiled) console.warn('[map] loading hex shader unavailable');
    return compiled;
  }, []);
  // Normalise on the JS thread: an arrow passed to .map() inside the worklet is
  // captured as a remote function, and calling one on the UI runtime is fatal.
  const uInk = useMemo(() => [ink[0] / 255, ink[1] / 255, ink[2] / 255], [ink]);
  const uniforms = useDerivedValue(() => ({
    uSize: [rect.width, rect.height],
    uScale: Math.max(0.001, scale.value),
    uPhase: phase.value,
    uInk,
  }));
  return (
    <Group transform={[{ translateX: rect.x }, { translateY: rect.y }]}>
      <Rect
        x={0}
        y={0}
        width={rect.width}
        height={rect.height}
        color={`rgb(${ink.join(',')})`}
        opacity={effect ? 1 : 0.08}
      >
        {effect ? <Shader source={effect} uniforms={uniforms} /> : null}
      </Rect>
    </Group>
  );
}
